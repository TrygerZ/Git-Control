/**
 * Zustand stores: four slices, one per PRD concern.
 *
 * Rules that hold everywhere in this file:
 *   - the webview never stores a `statusToken`; it is read from the freshest
 *     status right before a mutation and discarded afterwards
 *   - every mutation invalidates server state by refetching, never by patching
 *     local copies
 *   - `event/repoChanged` invalidates with a 250 ms client debounce on top of
 *     the host's own 500 ms watcher debounce
 */
import { create } from 'zustand';
import { BridgeRequestError, bridge, isBridgeError, mutation, saveState } from './bridge';
import { sanitizeGitText } from './format';
import { pruneSelection, toggleNode, togglePath, type TreeNode } from './tree';
import { clampZoom } from './viewport';
import type {
  ChangeEntry,
  CommitResult,
  ConflictEntry,
  ErrorBody,
  GitActionRequest,
  GitHubAuthState,
  GitHubLinkage,
  GitHubRateLimit,
  MutationMeta,
  PullRequestInfo,
  RepoGraph,
  RepoStatus,
  SettingsSnapshot,
} from '../messages';
import { ROW_HEIGHT, LANE_WIDTH } from './viewport';

/** Client-side coalescing of host change notifications. */
const REFRESH_DEBOUNCE_MS = 250;
/** Live progress log cap; older lines drop off the front. */
const PROGRESS_CAP = 200;
const TOAST_TTL_MS = 6000;
const SEARCH_MAX = 100;

/** Any thrown value → an `ErrorBody` the UI can render. */
export function toErrorBody(err: unknown): ErrorBody {
  if (isBridgeError(err)) return err.body;
  return {
    status: 500,
    code: 'SERVER_ERROR',
    message: err instanceof Error ? err.message : String(err),
  };
}

// ------------------------------------------------------------------- toasts

export interface Toast {
  id: string;
  level: 'info' | 'warning' | 'error';
  message: string;
  detail?: string;
  /** Offer a `Show Logs` button; set for server errors. */
  showLogs?: boolean;
}

// ---------------------------------------------------------------- repoStore

export interface RepoState {
  status: RepoStatus | null;
  graph: RepoGraph | null;
  selectedHash: string | null;
  loading: boolean;
  /** `true` while a `loadMore` page is in flight. */
  paging: boolean;
  error: ErrorBody | null;
  /** Mirrors `graph.stale`: the payload is a cached snapshot. */
  stale: boolean;
  loadStatus(): Promise<void>;
  loadGraph(): Promise<void>;
  loadMore(): Promise<void>;
  selectCommit(hash: string | null): void;
  refresh(): Promise<void>;
}

export const useRepoStore = create<RepoState>((set, get) => ({
  status: null,
  graph: null,
  selectedHash: null,
  loading: false,
  paging: false,
  error: null,
  stale: false,

  async loadStatus() {
    try {
      const status = await bridge.request('repos/status', {});
      set({ status, error: null });
    } catch (err) {
      set({ error: toErrorBody(err) });
    }
  },

  async loadGraph() {
    set({ loading: true });
    try {
      const graph = await bridge.request('repos/graph', {
        rowHeight: ROW_HEIGHT,
        laneWidth: LANE_WIDTH,
      });
      set({ graph, stale: graph.stale, loading: false, error: null });
    } catch (err) {
      set({ loading: false, error: toErrorBody(err) });
    }
  },

  /** Append the next page. Cursor comes from the server, never computed here. */
  async loadMore() {
    const current = get().graph;
    if (current === null || current.nextCursor === null || get().paging) return;
    set({ paging: true });
    try {
      const page = await bridge.request('repos/graph', {
        cursor: current.nextCursor,
        rowHeight: ROW_HEIGHT,
        laneWidth: LANE_WIDTH,
      });
      set({ graph: mergeGraph(current, page), stale: page.stale, paging: false, error: null });
    } catch (err) {
      set({ paging: false, error: toErrorBody(err) });
    }
  },

  selectCommit(hash) {
    set({ selectedHash: hash });
    saveState({ selectedHash: hash });
  },

  async refresh() {
    await Promise.all([get().loadStatus(), get().loadGraph()]);
  },
}));

/**
 * Concatenate a page onto the loaded graph.
 *
 * The host lays out each page independently, so a later page's `y` restarts at
 * 0. Rows are re-stacked here by index; lane assignment is left untouched
 * because re-laying-out client-side would contradict "do not reimplement layout".
 */
export function mergeGraph(base: RepoGraph, page: RepoGraph): RepoGraph {
  const seen = new Set(base.nodes.map((n) => n.hash));
  const offset = base.nodes.length;
  const added = page.nodes
    .filter((n) => !seen.has(n.hash))
    .map((n, i) => ({ ...n, y: (offset + i) * ROW_HEIGHT }));
  const edgeKey = (e: { from: string; to: string }): string => `${e.from}->${e.to}`;
  const edgeSeen = new Set(base.edges.map(edgeKey));
  const laneCount = Math.max(base.lanes.length, page.lanes.length);
  const lanes = laneCount === base.lanes.length ? base.lanes : page.lanes;

  return {
    ...page,
    nodes: [...base.nodes, ...added],
    edges: [...base.edges, ...page.edges.filter((e) => !edgeSeen.has(edgeKey(e)))],
    lanes,
    refs: page.refs.length > 0 ? page.refs : base.refs,
  };
}

// ------------------------------------------------------------- changesStore

export interface ChangesState {
  changes: ChangeEntry[];
  conflicts: ConflictEntry[];
  selection: Set<string>;
  collapsed: Set<string>;
  commitMessage: string;
  pushAfterCommit: boolean;
  includeUntracked: boolean;
  busy: boolean;
  loading: boolean;
  error: ErrorBody | null;
  /** Inline validation message for the commit form, or `null` when valid. */
  messageError: string | null;
  /** Set when a commit landed but its push failed, so retry can reuse the key. */
  retryPush: (() => Promise<void>) | null;
  load(): Promise<void>;
  toggle(path: string): void;
  toggleFolder(node: TreeNode): void;
  toggleCollapsed(prefix: string): void;
  selectAll(): void;
  clear(): void;
  setCommitMessage(message: string): void;
  setPushAfterCommit(value: boolean): void;
  setIncludeUntracked(value: boolean): void;
  stage(paths: string[]): Promise<void>;
  unstage(paths: string[]): Promise<void>;
  commit(): Promise<boolean>;
}

export const COMMIT_MESSAGE_MIN = 3;
export const MESSAGE_REQUIRED = 'Pesan commit wajib diisi.';

export const useChangesStore = create<ChangesState>((set, get) => ({
  changes: [],
  conflicts: [],
  selection: new Set<string>(),
  collapsed: new Set<string>(),
  commitMessage: '',
  pushAfterCommit: false,
  includeUntracked: false,
  busy: false,
  loading: false,
  error: null,
  messageError: null,
  retryPush: null,

  async load() {
    set({ loading: true });
    try {
      const status = await bridge.request('repos/status', {});
      set({
        changes: status.changes,
        conflicts: status.conflicts,
        selection: pruneSelection(get().selection, status.changes),
        loading: false,
        error: null,
      });
    } catch (err) {
      set({ loading: false, error: toErrorBody(err) });
    }
  },

  toggle(path) {
    const selection = togglePath(path, get().selection);
    set({ selection });
    saveState({ selectedPaths: [...selection] });
  },

  toggleFolder(node) {
    const selection = toggleNode(node, get().selection);
    set({ selection });
    saveState({ selectedPaths: [...selection] });
  },

  toggleCollapsed(prefix) {
    const collapsed = new Set(get().collapsed);
    if (collapsed.has(prefix)) collapsed.delete(prefix);
    else collapsed.add(prefix);
    set({ collapsed });
    saveState({ collapsedFolders: [...collapsed] });
  },

  selectAll() {
    const selection = new Set(get().changes.map((c) => c.path));
    set({ selection });
    saveState({ selectedPaths: [...selection] });
  },

  clear() {
    set({ selection: new Set<string>() });
    saveState({ selectedPaths: [] });
  },

  setCommitMessage(message) {
    set({
      commitMessage: message,
      messageError: message.trim().length >= COMMIT_MESSAGE_MIN ? null : get().messageError,
    });
    saveState({ commitMessage: message });
  },

  setPushAfterCommit(value) {
    set({ pushAfterCommit: value });
    saveState({ pushAfterCommit: value });
  },

  setIncludeUntracked(value) {
    set({ includeUntracked: value });
    saveState({ includeUntracked: value });
  },

  async stage(paths) {
    await runStage(paths, true, set, get);
  },

  async unstage(paths) {
    await runStage(paths, false, set, get);
  },

  /**
   * Commit what is staged. Returns `true` on success so the caller can clear
   * the form. A failed push does NOT undo the commit: `retryPush` is armed with
   * the SAME idempotency key so the host deduplicates a double click.
   */
  async commit() {
    const message = get().commitMessage;
    if (message.trim().length < COMMIT_MESSAGE_MIN) {
      set({ messageError: MESSAGE_REQUIRED });
      return false;
    }
    set({ busy: true, messageError: null });
    const ops = useOperationStore.getState();
    try {
      const token = await freshToken();
      // `statusToken` rides in the meta, not the payload: it is part of
      // `MutationMeta` now that every mutation kind honours it.
      const handle = mutation('actions/commit', {
        message,
        push: get().pushAfterCommit,
      });
      const result: CommitResult = await handle.send({ statusToken: token });
      set({ busy: false, commitMessage: '', selection: new Set<string>() });
      saveState({ commitMessage: '', selectedPaths: [] });
      if (get().pushAfterCommit && !result.pushed) {
        ops.pushToast({
          level: 'warning',
          message: 'Commit berhasil, push gagal.',
          ...(result.pushError === undefined ? {} : { detail: result.pushError }),
        });
        set({
          retryPush: async () => {
            // Same key AND the same token as the original attempt: within the
            // host's idempotency window this replays the stored outcome, and past
            // it the now-stale token turns a would-be second commit into a 409.
            await handle.send({ statusToken: token });
          },
        });
      } else {
        set({ retryPush: null });
        ops.pushToast({ level: 'info', message: 'Commit berhasil.' });
      }
      await get().load();
      await useRepoStore.getState().refresh();
      return true;
    } catch (err) {
      set({ busy: false });
      ops.fail(err);
      return false;
    }
  },
}));

type ChangesSetter = (patch: Partial<ChangesState>) => void;

/** Shared stage/unstage path: token → mutate → refetch. */
async function runStage(
  paths: string[],
  stage: boolean,
  set: ChangesSetter,
  get: () => ChangesState,
): Promise<void> {
  if (paths.length === 0) return;
  set({ busy: true });
  try {
    const token = await freshToken();
    await mutation('actions/stage', { paths, stage }).send({ statusToken: token });
    set({ busy: false });
    await get().load();
    await useRepoStore.getState().loadStatus();
  } catch (err) {
    set({ busy: false });
    useOperationStore.getState().fail(err);
  }
}

/** Read the newest token straight from the host; never cache it. */
async function freshToken(): Promise<string> {
  const status = await bridge.request('repos/status', {});
  useRepoStore.setState({ status });
  return status.statusToken;
}

// ----------------------------------------------------------- operationStore

export interface PendingGuard {
  /** The action the user asked for, replayed once confirmed. */
  request: GitActionRequest;
  error: ErrorBody;
  /** Re-send with the original idempotency key plus confirmation flags. */
  retry(extra: Partial<MutationMeta>): Promise<void>;
}

export interface OperationState_ {
  state: 'idle' | 'loading' | 'success' | 'error' | 'conflict';
  progressLog: string[];
  pendingGuard: PendingGuard | null;
  toasts: Toast[];
  lastError: ErrorBody | null;
  runAction(request: GitActionRequest): Promise<boolean>;
  confirmGuard(extra: Partial<MutationMeta>): Promise<void>;
  dismissGuard(): void;
  pushToast(toast: Omit<Toast, 'id'>): void;
  dismissToast(id: string): void;
  fail(err: unknown): void;
  appendProgress(line: string): void;
  clearProgress(): void;
  showLogs(): void;
}

export const useOperationStore = create<OperationState_>((set, get) => ({
  state: 'idle',
  progressLog: [],
  pendingGuard: null,
  toasts: [],
  lastError: null,

  /**
   * Run a git action. A guard rejection is not an error state: it parks the
   * request in `pendingGuard` so `GuardDialog` can offer the remedies and then
   * replay the SAME mutation with `confirm: true`.
   *
   * Every send — including a confirmation retry — carries a freshly read
   * `statusToken`, so the host can reject an action computed against a repository
   * that has since moved. The token is deliberately re-read per attempt rather
   * than captured once: the user reads the dialog, thinks, and clicks Confirm, and
   * the request that lands must be judged against the tree as it is then.
   */
  async runAction(request) {
    set({ state: 'loading', lastError: null });
    const handle = mutation('actions/git', request);
    const send = async (extra: Partial<MutationMeta>): Promise<boolean> => {
      const statusToken = await freshToken();
      const result = await handle.send({ statusToken, ...extra });
      set({ state: 'success', pendingGuard: null });
      await useRepoStore.getState().refresh();
      await useChangesStore.getState().load();
      if (result.operation !== 'idle') set({ state: 'conflict' });
      return true;
    };
    try {
      return await send({});
    } catch (err) {
      const body = toErrorBody(err);
      const needsDialog =
        body.requiresConfirmation === true ||
        body.code === 'CONFIRMATION_REQUIRED' ||
        (body.remedies !== undefined && body.remedies.length > 0);
      if (needsDialog) {
        set({
          state: 'idle',
          pendingGuard: {
            request,
            error: body,
            retry: async (extra) => {
              try {
                await send(extra);
              } catch (retryErr) {
                get().fail(retryErr);
                set({ pendingGuard: null });
              }
            },
          },
        });
        return false;
      }
      get().fail(err);
      return false;
    }
  },

  async confirmGuard(extra) {
    const guard = get().pendingGuard;
    if (guard === null) return;
    await guard.retry(extra);
  },

  dismissGuard() {
    set({ pendingGuard: null, state: 'idle' });
  },

  pushToast(toast) {
    const id = crypto.randomUUID();
    set({ toasts: [...get().toasts, { ...toast, id }] });
  },

  dismissToast(id) {
    set({ toasts: get().toasts.filter((t) => t.id !== id) });
  },

  fail(err) {
    const body = toErrorBody(err);
    set({ state: 'error', lastError: body });
    get().pushToast({
      level: 'error',
      message: body.message,
      ...(body.detail === undefined ? {} : { detail: body.detail }),
      showLogs: body.code === 'SERVER_ERROR' || body.code === 'HOOK_REJECTED',
    });
  },

  appendProgress(line) {
    // Progress lines are raw git stderr, so a remote or a hook chooses their
    // bytes. Sanitised on the way in: the log is rendered in a `<pre>`, where a
    // bidi override would reorder neighbouring lines as well as its own.
    const log = [...get().progressLog, sanitizeGitText(line)];
    set({ progressLog: log.length > PROGRESS_CAP ? log.slice(log.length - PROGRESS_CAP) : log });
  },

  clearProgress() {
    set({ progressLog: [] });
  },

  /**
   * Reveal the host Output channel through `actions/showLogs`, a kind whose only
   * effect is `channel.show(true)`. A failure is reported rather than swallowed.
   */
  showLogs() {
    void bridge.request('actions/showLogs', {}).catch(() => {
      get().pushToast({
        level: 'warning',
        message: 'Tidak bisa membuka log Git Control.',
      });
    });
  },
}));

export const TOAST_TIMEOUT_MS = TOAST_TTL_MS;

// ------------------------------------------------------------ settingsStore

export interface SettingsState {
  zoom: number;
  branchFilter: string;
  search: string;
  diffMode: 'unified' | 'side-by-side';
  snapshot: SettingsSnapshot | null;
  load(): Promise<void>;
  setZoom(zoom: number): void;
  setBranchFilter(filter: string): void;
  setSearch(search: string): void;
  setDiffMode(mode: 'unified' | 'side-by-side'): void;
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  zoom: 1,
  branchFilter: '',
  search: '',
  diffMode: 'unified',
  snapshot: null,

  async load() {
    try {
      const snapshot = await bridge.request('settings/get', {});
      set({
        snapshot,
        zoom: clampZoom(snapshot.ui.zoom),
        branchFilter: snapshot.ui.branchFilter,
      });
    } catch {
      // Settings are advisory; defaults keep the view usable.
    }
  },

  /** Zoom persists host-side so it survives a reload per workspace. */
  setZoom(zoom) {
    const clamped = clampZoom(zoom);
    if (clamped === get().zoom) return;
    set({ zoom: clamped });
    void persist('zoom', clamped);
  },

  setBranchFilter(filter) {
    set({ branchFilter: filter });
    void persist('branchFilter', filter);
  },

  setSearch(search) {
    set({ search: search.slice(0, SEARCH_MAX) });
  },

  setDiffMode(mode) {
    set({ diffMode: mode });
    saveState({ diffMode: mode });
  },
}));

async function persist(key: string, value: string | number | boolean): Promise<void> {
  try {
    const snapshot = await bridge.request('settings/set', { key, value });
    useSettingsStore.setState({ snapshot });
  } catch {
    // A failed persist must not block the interaction the user just made.
  }
}

// -------------------------------------------------------------- githubStore

export interface GitHubState {
  auth: GitHubAuthState | null;
  linkage: GitHubLinkage | null;
  pullRequests: PullRequestInfo[];
  rateLimit: GitHubRateLimit | null;
  loading: boolean;
  /** Set when GitHub itself failed; git keeps working regardless. */
  error: ErrorBody | null;
  load(): Promise<void>;
  loadPullRequests(): Promise<void>;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  openCommit(hash: string): Promise<void>;
  openUrl(url: string): Promise<void>;
}

/**
 * GitHub metadata slice.
 *
 * Nothing here is on the critical path: every failure degrades to `error` plus
 * the last known data, because the graph must stay usable when GitHub is down.
 * Push and fetch are NOT here — they go through `actions/git` to the Git CLI.
 */
export const useGitHubStore = create<GitHubState>((set, get) => ({
  auth: null,
  linkage: null,
  pullRequests: [],
  rateLimit: null,
  loading: false,
  error: null,

  async load() {
    set({ loading: true });
    try {
      const [auth, linkage] = await Promise.all([
        bridge.request('github/auth', {}),
        bridge.request('github/linkage', {}),
      ]);
      set({ auth, linkage, loading: false, error: null });
      if (linkage.available) await get().loadPullRequests();
    } catch (err) {
      set({ loading: false, error: toErrorBody(err) });
    }
  },

  async loadPullRequests() {
    const linkage = get().linkage;
    if (linkage === null || !linkage.available || linkage.owner === null || linkage.repo === null) return;
    try {
      const result = await bridge.request('github/pullRequests', {
        owner: linkage.owner,
        repo: linkage.repo,
        state: 'open',
      });
      set({ pullRequests: result.pullRequests, rateLimit: result.rateLimit, error: null });
    } catch (err) {
      // Keep the previous list: stale PR chips beat an empty panel.
      set({ error: toErrorBody(err) });
    }
  },

  async connect() {
    try {
      const auth = await bridge.request('github/connect', {});
      set({ auth, error: null });
      if (auth.invalidToken === true) {
        useOperationStore.getState().pushToast({ level: 'warning', message: 'Token GitHub tidak valid.' });
      }
      await get().load();
    } catch (err) {
      set({ error: toErrorBody(err) });
    }
  },

  async disconnect() {
    try {
      const auth = await bridge.request('github/disconnect', {});
      set({ auth, pullRequests: [], rateLimit: null, error: null });
    } catch (err) {
      set({ error: toErrorBody(err) });
    }
  },

  /** External navigation happens host-side; the webview CSP forbids it here. */
  async openCommit(hash) {
    const template = get().linkage?.commitUrlTemplate ?? null;
    if (template === null) return;
    await get().openUrl(template.replace('{hash}', hash));
  },

  async openUrl(url) {
    try {
      await bridge.request('actions/openExternal', { url });
    } catch (err) {
      useOperationStore.getState().pushToast({
        level: 'warning',
        message: toErrorBody(err).message,
      });
    }
  },
}));

// ----------------------------------------------------------- event plumbing

let wired = false;
let refreshTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * Subscribe the stores to host events. Idempotent, so both roots may call it.
 * Returns an unsubscribe for symmetry even though the webview lives as long as
 * the document.
 */
export function wireHostEvents(mode: 'explorer' | 'pending'): () => void {
  if (wired) return () => undefined;
  wired = true;

  const offChanged = bridge.on('event/repoChanged', () => {
    if (refreshTimer !== undefined) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      if (mode === 'explorer') void useRepoStore.getState().refresh();
      else {
        void useChangesStore.getState().load();
        void useRepoStore.getState().loadStatus();
      }
    }, REFRESH_DEBOUNCE_MS);
  });

  const offProgress = bridge.on('event/operationProgress', (payload) => {
    const line =
      payload.message === undefined
        ? `${payload.operation}: ${payload.phase}`
        : `${payload.operation}: ${payload.message}`;
    useOperationStore.getState().appendProgress(line);
    if (payload.phase === 'failed') useOperationStore.setState({ state: 'error' });
  });

  const offToast = bridge.on('event/toast', (payload) => {
    useOperationStore.getState().pushToast({
      level: payload.level,
      message: payload.message,
      ...(payload.detail === undefined ? {} : { detail: payload.detail }),
    });
  });

  return () => {
    offChanged();
    offProgress();
    offToast();
    wired = false;
  };
}

/** Re-export so components do not import the bridge module directly. */
export { BridgeRequestError };
