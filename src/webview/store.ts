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
import { linkageChangedRepo, sanitizeGitText } from './format';
import { pruneSelection, toggleNode, togglePath, type ChangeSection, type TreeNode } from './tree';
import { activeLang, setActiveLang, t } from './i18n';
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
  IconThemeSnapshot,
} from '../messages';
import { clampZoom, COLUMN_WIDTH, LANE_HEIGHT, partitionUnrequestedHashes } from './viewport';

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

// ----------------------------------------------------------------- in-flight coalescing
let inFlightStatus: Promise<void> | null = null;
let inFlightChanges: Promise<void> | null = null;

export const useRepoStore = create<RepoState>((set, get) => ({
  status: null,
  graph: null,
  selectedHash: null,
  loading: false,
  paging: false,
  error: null,
  stale: false,

  async loadStatus() {
    if (inFlightStatus !== null) return inFlightStatus;
    inFlightStatus = (async () => {
      try {
        const status = await bridge.request('repos/status', {});
        set({ status, error: null });
      } catch (err) {
        set({ error: toErrorBody(err) });
      } finally {
        inFlightStatus = null;
      }
    })();
    return inFlightStatus;
  },

  async loadGraph() {
    set({ loading: true });
    try {
      const graph = await bridge.request('repos/graph', {
        laneHeight: LANE_HEIGHT,
        columnWidth: COLUMN_WIDTH,
      });
      set({ graph, stale: graph.stale, loading: false, error: null });
    } catch (err) {
      set({ loading: false, error: toErrorBody(err) });
    }
  },

  /** Load expanded window. Layout and global coordinates come from host in one go. */
  async loadMore() {
    const current = get().graph;
    if (current === null || current.nextCursor === null || get().paging) return;
    set({ paging: true });
    try {
      const pageSize = current.nodes.length > 0 ? current.nodes.length : 500;
      const nextLimit = Math.min(current.nextCursor + pageSize, 10_000);
      const page = await bridge.request('repos/graph', {
        cursor: 0,
        limit: nextLimit,
        laneHeight: LANE_HEIGHT,
        columnWidth: COLUMN_WIDTH,
      });
      set({ graph: page, stale: page.stale, paging: false, error: null });
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

// ------------------------------------------------------------- changesStore

export interface ChangesState {
  changes: ChangeEntry[];
  conflicts: ConflictEntry[];
  selection: Set<string>;
  collapsed: Set<string>;
  collapsedSections: Set<ChangeSection>;
  commitMessage: string;
  pushAfterCommit: boolean;
  busy: boolean;
  loading: boolean;
  hasLoaded: boolean;
  error: ErrorBody | null;
  /** Inline validation message for the commit form, or `null` when valid. */
  messageError: string | null;
  /** Set when a commit landed but its push failed, so retry can reuse the key. */
  retryPush: (() => Promise<void>) | null;
  load(): Promise<void>;
  toggle(path: string): void;
  toggleFolder(node: TreeNode): void;
  toggleCollapsed(prefix: string): void;
  toggleSection(section: ChangeSection): void;
  selectAll(): void;
  clear(): void;
  setCommitMessage(message: string): void;
  setPushAfterCommit(value: boolean): void;
  stage(paths: string[]): Promise<void>;
  unstage(paths: string[]): Promise<void>;
  commit(): Promise<boolean>;
}

export const COMMIT_MESSAGE_MIN = 3;

export const useChangesStore = create<ChangesState>((set, get) => ({
  changes: [],
  conflicts: [],
  selection: new Set<string>(),
  collapsed: new Set<string>(),
  collapsedSections: new Set<ChangeSection>(),
  commitMessage: '',
  pushAfterCommit: false,
  busy: false,
  loading: false,
  hasLoaded: false,
  error: null,
  messageError: null,
  retryPush: null,

  async load() {
    if (inFlightChanges !== null) return inFlightChanges;
    set({ loading: true });
    inFlightChanges = (async () => {
      try {
        const status = await bridge.request('repos/status', {});
        set({
          changes: status.changes,
          conflicts: status.conflicts,
          selection: pruneSelection(get().selection, status.changes),
          loading: false,
          hasLoaded: true,
          error: null,
        });
      } catch (err) {
        set({ loading: false, error: toErrorBody(err) });
      } finally {
        inFlightChanges = null;
      }
    })();
    return inFlightChanges;
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

  toggleSection(section) {
    const collapsedSections = new Set(get().collapsedSections);
    if (collapsedSections.has(section)) collapsedSections.delete(section);
    else collapsedSections.add(section);
    set({ collapsedSections });
    saveState({ collapsedSections: [...collapsedSections] });
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
    const strings = t(activeLang());
    if (message.trim().length < COMMIT_MESSAGE_MIN) {
      set({ messageError: strings.commitForm.messageRequired });
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
          message: strings.commitForm.commitPushFailed,
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
        ops.pushToast({ level: 'info', message: strings.commitForm.commitSuccess });
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
    const handleFailure = (err: unknown): boolean => {
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
                handleFailure(retryErr);
              }
            },
          },
        });
        return false;
      }
      get().fail(err);
      return false;
    };
    try {
      return await send({});
    } catch (err) {
      return handleFailure(err);
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
        message: t(activeLang()).ui.showLogsFailed,
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
  language: 'en' | 'id';
  snapshot: SettingsSnapshot | null;
  load(): Promise<void>;
  setZoom(zoom: number): void;
  setBranchFilter(filter: string): void;
  setSearch(search: string): void;
  setLanguage(language: 'en' | 'id'): void;
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  zoom: 1,
  branchFilter: '',
  search: '',
  language: 'en',
  snapshot: null,

  async load() {
    try {
      const snapshot = await bridge.request('settings/get', {});
      const language = snapshot.language === 'id' ? 'id' : 'en';
      set({
        snapshot,
        language,
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

  setLanguage(language) {
    const normalized = language === 'id' ? 'id' : 'en';
    if (normalized === get().language) return;
    set({ language: normalized });
    void persist('language', normalized);
  },
}));

/**
 * Invariant: activeLang() mirrors useSettingsStore.language via this single module subscription.
 * It must not be written to directly from other call sites.
 */
useSettingsStore.subscribe((state, prev) => {
  if (state.language !== prev.language) {
    setActiveLang(state.language);
  }
});

async function persist(key: string, value: string | number | boolean): Promise<void> {
  try {
    const snapshot = await bridge.request('settings/set', { key, value });
    useSettingsStore.setState({ snapshot });
  } catch {
    // A failed persist must not block the interaction the user just made.
  }
}

// -------------------------------------------------------------- iconThemeStore

/**
 * Read-only snapshot of the active File Icon Theme. Its own store, not a
 * `useSettingsStore` field: the value arrives unsolicited via
 * `event/iconThemeChanged`, is never persisted or mutated by the webview, and
 * changes on a different cadence (theme/extension install) than settings. Icons
 * are the only consumers.
 */
export interface IconThemeState {
  snapshot: IconThemeSnapshot | null;
}

export const useIconThemeStore = create<IconThemeState>(() => ({
  snapshot: null,
}));

// -------------------------------------------------------------- githubStore

export interface GitHubState {
  auth: GitHubAuthState | null;
  linkage: GitHubLinkage | null;
  pullRequests: PullRequestInfo[];
  avatars: Record<string, string | null>;
  rateLimit: GitHubRateLimit | null;
  loading: boolean;
  /** Set when GitHub itself failed; git keeps working regardless. */
  error: ErrorBody | null;
  load(): Promise<void>;
  loadPullRequests(): Promise<void>;
  loadCommitAuthors(hashes: string[]): Promise<void>;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  openCommit(hash: string): Promise<void>;
  openUrl(url: string): Promise<void>;
}

/**
 * Commit hashes already asked about, including the ones that came back without an
 * account. Module-scoped rather than in the store because it is a request ledger, not
 * state any component renders.
 */
const requestedCommitAuthorHashes = new Set<string>();

/**
 * Drop everything learned about commit authors. Avatars belong to one repository and
 * to one auth state, so a disconnect or a switch to another remote has to forget them
 * rather than serve the previous repository's faces.
 */
function resetCommitAuthors(set: (partial: Partial<GitHubState>) => void): void {
  requestedCommitAuthorHashes.clear();
  set({ avatars: {} });
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
  avatars: {},
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
      const prevLinkage = get().linkage;
      if (linkageChangedRepo(prevLinkage, linkage)) {
        resetCommitAuthors(set);
      }
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

  async loadCommitAuthors(hashes: string[]) {
    const linkage = get().linkage;
    if (linkage === null || !linkage.available || linkage.owner === null || linkage.repo === null) return;
    const batches = partitionUnrequestedHashes(hashes, requestedCommitAuthorHashes);
    if (batches.length === 0) return;

    // Recorded before the first await: the canvas fires this on every scroll settle, and
    // two overlapping calls would otherwise ask for the same hashes twice.
    for (const batch of batches) {
      for (const h of batch) {
        requestedCommitAuthorHashes.add(h);
      }
    }

    const { owner, repo } = linkage;
    await Promise.all(
      batches.map(async (batch) => {
        try {
          const result = await bridge.request('github/commitAuthors', { owner, repo, hashes: batch });
          set((state) => {
            const nextAvatars = { ...state.avatars };
            for (const author of result.authors) {
              nextAvatars[author.hash] = author.avatarUrl;
            }
            return { avatars: nextAvatars, rateLimit: result.rateLimit, error: null };
          });
        } catch (err) {
          // An avatar is decoration. Record it like a failed PR read and keep whatever faces
          // already arrived; nothing here is worth a toast.
          set({ error: toErrorBody(err) });
        }
      }),
    );
  },

  async connect() {
    try {
      const auth = await bridge.request('github/connect', {});
      set({ auth, error: null });
      if (auth.invalidToken === true) {
        useOperationStore.getState().pushToast({
          level: 'warning',
          message: t(activeLang()).format.githubConnection.invalidToken,
        });
      }
      await get().load();
    } catch (err) {
      set({ error: toErrorBody(err) });
    }
  },

  async disconnect() {
    try {
      const auth = await bridge.request('github/disconnect', {});
      resetCommitAuthors(set);
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
        void useRepoStore.getState().refresh();
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

  const offSettings = bridge.on('event/settingsChanged', (snapshot) => {
    const language = snapshot.language === 'id' ? 'id' : 'en';
    // Always store the fresh snapshot so it does not go stale.
    useSettingsStore.setState({ snapshot });
    // setLanguage checks `if (normalized === get().language) return;`, which
    // makes the self-echo from the initiating webview an immediate no-op and
    // prevents a persist -> broadcast -> persist loop.
    useSettingsStore.getState().setLanguage(language);
  });

  const offIconTheme = bridge.on('event/iconThemeChanged', (snapshot) => {
    useIconThemeStore.setState({ snapshot });
  });

  return () => {
    offChanged();
    offProgress();
    offToast();
    offSettings();
    offIconTheme();
    wired = false;
  };
}

/** Re-export so components do not import the bridge module directly. */
export { BridgeRequestError };
