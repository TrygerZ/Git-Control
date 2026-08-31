/**
 * Webview side of the message bridge.
 *
 * Implements {@link Bridge} from `src/messages.ts`. `acquireVsCodeApi()` is
 * called exactly once at module scope — VS Code throws on a second call, and a
 * module is the only place that guarantees single evaluation inside an IIFE
 * bundle.
 *
 * Mutations go through {@link mutate}, which mints one `idempotencyKey` per
 * logical operation and reuses it on retry so the host replays the previous
 * outcome instead of pushing twice (PRD Kasus 2).
 */
import type {
  Bridge,
  ErrorBody,
  EventKind,
  EventMap,
  HostMessage,
  MutationMeta,
  Request,
  RequestKind,
  RequestPayload,
  Response,
  ResponseData,
} from '../messages';
import { isHostEvent } from '../messages';

/** Shape of the object the host injects. Not covered by `@types/vscode`. */
interface VsCodeApi {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

/** Requests are abandoned after this long so a lost reply cannot hang a spinner. */
const REQUEST_TIMEOUT_MS = 120_000;

/** Persisted between webview rebuilds; the pending view is not retained. */
export interface WebviewState {
  selectedHash: string | null;
  scrollTop: number;
  collapsedFolders: string[];
  selectedPaths: string[];
  commitMessage: string;
  pushAfterCommit: boolean;
  includeUntracked: boolean;
  diffMode: 'unified' | 'side-by-side';
}

const DEFAULT_STATE: WebviewState = {
  selectedHash: null,
  scrollTop: 0,
  collapsedFolders: [],
  selectedPaths: [],
  commitMessage: '',
  pushAfterCommit: false,
  includeUntracked: false,
  diffMode: 'unified',
};

/** Rejection carrying the full {@link ErrorBody} so the UI can render remedies. */
export class BridgeRequestError extends Error {
  readonly body: ErrorBody;

  constructor(body: ErrorBody) {
    super(body.message);
    this.name = 'BridgeRequestError';
    this.body = body;
  }

  /** `true` when the host is asking for an explicit confirmation click. */
  get requiresConfirmation(): boolean {
    return this.body.requiresConfirmation === true || this.body.code === 'CONFIRMATION_REQUIRED';
  }
}

/** Narrow an unknown rejection to our typed error. */
export function isBridgeError(err: unknown): err is BridgeRequestError {
  return err instanceof BridgeRequestError;
}

/** Fallback body for transport-level failures that never reached the host. */
function timeoutBody(kind: string): ErrorBody {
  return {
    status: 504,
    code: 'UNAVAILABLE',
    message: 'Permintaan melebihi batas waktu.',
    detail: kind,
  };
}

interface Pending {
  resolve(data: unknown): void;
  reject(err: BridgeRequestError): void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * The single api handle. Guarded because the test bundle and any accidental
 * double-import must not crash the view; without a host we degrade to a stub
 * that fails every request loudly instead of silently doing nothing.
 */
const api: VsCodeApi = (() => {
  if (typeof acquireVsCodeApi === 'function') return acquireVsCodeApi();
  let state: unknown = undefined;
  return {
    postMessage: () => undefined,
    getState: () => state,
    setState: (next: unknown) => {
      state = next;
    },
  };
})();

class WebviewBridge implements Bridge {
  private readonly pending = new Map<string, Pending>();
  private readonly listeners = new Map<EventKind, Set<(payload: never) => void>>();

  constructor() {
    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      window.addEventListener('message', (event: MessageEvent<unknown>) => {
        this.receive(event.data);
      });
    }
  }

  request<K extends RequestKind>(kind: K, payload: RequestPayload<K>): Promise<ResponseData<K>> {
    const id = newId();
    const envelope: Request<K> = { id, kind, payload };
    return new Promise<ResponseData<K>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new BridgeRequestError(timeoutBody(kind)));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, {
        resolve: (data) => resolve(data as ResponseData<K>),
        reject,
        timer,
      });
      api.postMessage(envelope);
    });
  }

  on<K extends EventKind>(kind: K, handler: (payload: EventMap[K]) => void): () => void {
    let set = this.listeners.get(kind);
    if (set === undefined) {
      set = new Set();
      this.listeners.set(kind, set);
    }
    const wrapped = handler as (payload: never) => void;
    set.add(wrapped);
    return () => {
      set?.delete(wrapped);
    };
  }

  private receive(raw: unknown): void {
    if (typeof raw !== 'object' || raw === null) return;
    const message = raw as HostMessage;
    if (isHostEvent(message)) {
      const set = this.listeners.get(message.kind);
      if (set === undefined) return;
      // Copy first: a handler may unsubscribe during dispatch.
      for (const handler of [...set]) (handler as (p: unknown) => void)(message.payload);
      return;
    }
    this.settle(message as Response);
  }

  private settle(response: Response): void {
    const entry = this.pending.get(response.id);
    if (entry === undefined) return; // Late reply after a timeout; drop it.
    this.pending.delete(response.id);
    clearTimeout(entry.timer);
    if (response.ok) entry.resolve(response.data);
    else entry.reject(new BridgeRequestError(response.error));
  }
}

export const bridge: Bridge = new WebviewBridge();

// ---------------------------------------------------------------- mutations

/** A mutation whose idempotency key survives retries. */
export interface MutationHandle<K extends RequestKind> {
  readonly kind: K;
  readonly idempotencyKey: string;
  /**
   * Send (or re-send) the mutation. Extra meta is merged in, which is how the
   * guard dialog adds `confirm` / `forceAcknowledgement` to the SAME key.
   */
  send(extra?: Partial<MutationMeta>): Promise<ResponseData<K>>;
}

/**
 * Create a retryable mutation. The key is minted once, so a user hammering
 * `Coba Push Lagi` replays the host's stored outcome rather than pushing again.
 */
export function mutation<K extends RequestKind>(
  kind: K,
  payload: Omit<RequestPayload<K>, keyof MutationMeta>,
): MutationHandle<K> {
  const idempotencyKey = newId();
  return {
    kind,
    idempotencyKey,
    send: (extra: Partial<MutationMeta> = {}) =>
      bridge.request(kind, {
        ...(payload as object),
        idempotencyKey,
        ...extra,
      } as RequestPayload<K>),
  };
}

/** One-shot mutation for callers that will not retry. */
export function mutate<K extends RequestKind>(
  kind: K,
  payload: Omit<RequestPayload<K>, keyof MutationMeta>,
  extra: Partial<MutationMeta> = {},
): Promise<ResponseData<K>> {
  return mutation(kind, payload).send(extra);
}

// ------------------------------------------------------------------- state

/** Restore the persisted view state, filling gaps with defaults. */
export function loadState(): WebviewState {
  const raw = api.getState();
  if (typeof raw !== 'object' || raw === null) return { ...DEFAULT_STATE };
  const partial = raw as Partial<WebviewState>;
  return {
    selectedHash: typeof partial.selectedHash === 'string' ? partial.selectedHash : null,
    scrollTop: typeof partial.scrollTop === 'number' ? partial.scrollTop : 0,
    collapsedFolders: Array.isArray(partial.collapsedFolders)
      ? partial.collapsedFolders.filter((v): v is string => typeof v === 'string')
      : [],
    selectedPaths: Array.isArray(partial.selectedPaths)
      ? partial.selectedPaths.filter((v): v is string => typeof v === 'string')
      : [],
    commitMessage: typeof partial.commitMessage === 'string' ? partial.commitMessage : '',
    pushAfterCommit: partial.pushAfterCommit === true,
    includeUntracked: partial.includeUntracked === true,
    diffMode: partial.diffMode === 'side-by-side' ? 'side-by-side' : 'unified',
  };
}

let cachedState: WebviewState | undefined;

/** Merge a patch into the persisted state. Cheap enough to call per keystroke. */
export function saveState(patch: Partial<WebviewState>): void {
  cachedState = { ...(cachedState ?? loadState()), ...patch };
  api.setState(cachedState);
}

/** Fresh request/idempotency id. `crypto.randomUUID` is available in webviews. */
export function newId(): string {
  return crypto.randomUUID();
}
