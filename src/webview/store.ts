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
import { BridgeRequestError, bridge, fetchContributorIdentity, fetchContributors, isBridgeError, loadState, mutation, saveState } from './bridge';
import { unknownErrorBody } from '../errorBody';
import { amendBlockedReason, joinCommitMessage, linkageChangedRepo, sanitizeGitText } from './format';
import { DEFAULT_ROUTE, resolveInitialRoute, sameRoute } from './route';
import type { NavCounts } from './navCounts';
import { pruneSelection, toggleNode, togglePath, type ChangeSection, type TreeNode } from './tree';
import { activeLang, setActiveLang, t } from './i18n';
import type {
  BranchRef,
  ChangeEntry,
  CommitDetail,
  CommitResult,
  ConflictEntry,
  ContributorIdentity,
  ContributorInfo,
  ErrorBody,
  FocusTarget,
  GitActionRequest,
  GitHubAuthState,
  GitHubLinkage,
  GitHubRateLimit,
  IssueInfo,
  IssueListFilter,
  IssueStateFilter,
  MutationMeta,
  PullRequestInfo,
  RepoGraph,
  RepoStatus,
  Route,
  RouteId,
  RunJobInfo,
  LogLine,
  LogState,
  SettingsSnapshot,
  StashEntry,
  StashFile,
  IconThemeSnapshot,
  WorkflowInfo,
  WorkflowRunInfo,
  WorktreeInfo,
} from '../messages';
import { failingDot, firstFailedJob } from './actionsModel';
import type { BranchesSectionKey, BranchSort } from './branchesModel';
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
  return unknownErrorBody(err);
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
  contributors: ContributorInfo[];
  contributorsLoading: boolean;
  contributorsLoaded: boolean;
  contributorsExpanded: boolean;
  authorFilter: string | null;
  contributorIdentities: Record<string, ContributorIdentity | null>;
  focusTargetHash: string | null;
  loadStatus(): Promise<void>;
  loadGraph(): Promise<void>;
  loadMore(): Promise<void>;
  selectCommit(hash: string | null): void;
  focusCommit(hash: string): void;
  loadContributors(): Promise<void>;
  loadContributorIdentity(email: string): Promise<ContributorIdentity | null>;
  toggleContributorsExpanded(): void;
  setAuthorFilter(email: string | null): void;
  refresh(): Promise<void>;
}

// ----------------------------------------------------------------- in-flight coalescing
let inFlightStatus: Promise<void> | null = null;
let inFlightChanges: Promise<void> | null = null;
let inFlightContributors: Promise<void> | null = null;
const inFlightContributorIdentities = new Map<string, Promise<ContributorIdentity | null>>();

export const useRepoStore = create<RepoState>((set, get) => ({
  status: null,
  graph: null,
  selectedHash: null,
  loading: false,
  paging: false,
  error: null,
  stale: false,
  contributors: [],
  contributorsLoading: false,
  contributorsLoaded: false,
  contributorsExpanded: true,
  authorFilter: null,
  contributorIdentities: {},
  focusTargetHash: null,

  async loadStatus() {
    if (inFlightStatus !== null) return inFlightStatus;
    inFlightStatus = (async () => {
      try {
        const status = await bridge.request('repos/status', {});
        set({ status, error: null });
      } catch (err) {
        const body = toErrorBody(err);
        set({ error: body });
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
      const body = toErrorBody(err);
      set({ loading: false, error: body });
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
      const body = toErrorBody(err);
      set({ paging: false, error: body });
    }
  },

  selectCommit(hash) {
    set({ selectedHash: hash });
    saveState({ selectedHash: hash });
  },

  focusCommit(hash) {
    set({ selectedHash: hash, focusTargetHash: hash });
    saveState({ selectedHash: hash });
  },

  toggleContributorsExpanded() {
    set((state) => ({ contributorsExpanded: !state.contributorsExpanded }));
  },

  setAuthorFilter(email) {
    set({ authorFilter: email });
  },

  async loadContributors() {
    if (inFlightContributors !== null) return inFlightContributors;
    inFlightContributors = (async () => {
      set({ contributorsLoading: true });
      try {
        const contributors = await fetchContributors();
        set({ contributors, contributorsLoading: false, contributorsLoaded: true });
      } catch {
        set({ contributors: [], contributorsLoading: false, contributorsLoaded: true });
      } finally {
        inFlightContributors = null;
      }
    })();
    return inFlightContributors;
  },

  async loadContributorIdentity(email) {
    const trimmed = email.trim();
    if (trimmed.length === 0) return null;
    const cached = get().contributorIdentities[trimmed];
    if (cached !== undefined) return cached;
    const running = inFlightContributorIdentities.get(trimmed);
    if (running !== undefined) return running;

    const promise = (async () => {
      try {
        const identity = await fetchContributorIdentity(trimmed);
        set((state) => ({
          contributorIdentities: {
            ...state.contributorIdentities,
            [trimmed]: identity,
          },
        }));
        return identity;
      } catch {
        const fallback: ContributorIdentity = { login: null, avatarUrl: null, htmlUrl: null };
        set((state) => ({
          contributorIdentities: {
            ...state.contributorIdentities,
            [trimmed]: fallback,
          },
        }));
        return fallback;
      } finally {
        inFlightContributorIdentities.delete(trimmed);
      }
    })();

    inFlightContributorIdentities.set(trimmed, promise);
    return promise;
  },

  async refresh() {
    await Promise.all([get().loadStatus(), get().loadGraph(), get().loadContributors()]);
  },
}));

// ------------------------------------------------------------- changesStore

/** The HEAD commit the form is amending, captured when the toggle turns on. */
export interface AmendBase {
  hash: string;
  shortHash: string;
  subject: string;
  message: string;
}

export interface ChangesState {
  changes: ChangeEntry[];
  conflicts: ConflictEntry[];
  stashes: StashEntry[];
  stashesLoading: boolean;
  stashesExpanded: Set<number>;
  stashContents: Record<number, StashFile[]>;
  stashContentsLoading: Set<number>;
  selection: Set<string>;
  collapsed: Set<string>;
  collapsedSections: Set<ChangeSection>;
  commitMessage: string;
  pushAfterCommit: boolean;
  amend: boolean;
  amendBase: AmendBase | null;
  /** The draft that was in the box before amend turned on; restored on toggle off. */
  amendDraft: string | null;
  busy: boolean;
  /** Which changes-store mutation is running; `null` while `busy` comes only from `opBusy`. */
  busyKind: 'stage' | 'commit' | null;
  loading: boolean;
  hasLoaded: boolean;
  error: ErrorBody | null;
  /** Inline validation message for the commit form, or `null` when valid. */
  messageError: string | null;
  /** Set when a commit landed but its push failed, so retry can reuse the key. */
  retryPush: (() => Promise<void>) | null;
  load(): Promise<void>;
  loadStashes(): Promise<void>;
  toggleStashExpanded(index: number): Promise<void>;
  applyStash(index: number): Promise<boolean>;
  dropStash(index: number): Promise<boolean>;
  toggle(path: string): void;
  toggleFolder(node: TreeNode): void;
  toggleCollapsed(prefix: string): void;
  toggleSection(section: ChangeSection): void;
  selectAll(): void;
  clear(): void;
  setCommitMessage(message: string): void;
  setPushAfterCommit(value: boolean): void;
  setAmend(on: boolean): Promise<void>;
  stage(paths: string[]): Promise<void>;
  unstage(paths: string[]): Promise<void>;
  commit(): Promise<boolean>;
}

export const COMMIT_MESSAGE_MIN = 3;

/** Drop stash content cache entries whose index is no longer within bounds. */
export function pruneStashCache(
  contents: Record<number, StashFile[]>,
  stashCount: number,
): Record<number, StashFile[]> {
  const next: Record<number, StashFile[]> = {};
  for (const [k, v] of Object.entries(contents)) {
    const idx = Number(k);
    if (idx >= 0 && idx < stashCount && v !== undefined) {
      next[idx] = v;
    }
  }
  return next;
}

export const useChangesStore = create<ChangesState>((set, get) => ({
  changes: [],
  conflicts: [],
  stashes: [],
  stashesLoading: false,
  stashesExpanded: new Set<number>(),
  stashContents: {},
  stashContentsLoading: new Set<number>(),
  selection: new Set<string>(),
  collapsed: new Set<string>(),
  collapsedSections: new Set<ChangeSection>(),
  commitMessage: '',
  pushAfterCommit: false,
  amend: false,
  amendBase: null,
  amendDraft: null,
  busy: false,
  busyKind: null,
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
        const [status, stashes] = await Promise.all([
          bridge.request('repos/status', {}),
          bridge.request('stash/list', {}).catch(() => [] as StashEntry[]),
        ]);
        const prevStashes = get().stashes;
        const stashesChanged =
          prevStashes.length !== stashes.length ||
          prevStashes.some((s, i) => s.ref !== stashes[i]?.ref || s.hash !== stashes[i]?.hash);
        const nextContents = stashesChanged
          ? pruneStashCache(get().stashContents, stashes.length)
          : get().stashContents;
        set({
          changes: status.changes,
          conflicts: status.conflicts,
          stashes,
          ...(stashesChanged ? { stashesExpanded: new Set<number>() } : {}),
          stashContents: nextContents,
          selection: pruneSelection(get().selection, status.changes),
          loading: false,
          hasLoaded: true,
          error: null,
        });
      } catch (err) {
        const body = toErrorBody(err);
        set({ loading: false, error: body });
      } finally {
        inFlightChanges = null;
      }
    })();
    return inFlightChanges;
  },

  async loadStashes() {
    set({ stashesLoading: true });
    try {
      const stashes = await bridge.request('stash/list', {});
      const prevStashes = get().stashes;
      const stashesChanged =
        prevStashes.length !== stashes.length ||
        prevStashes.some((s, i) => s.ref !== stashes[i]?.ref || s.hash !== stashes[i]?.hash);
      const nextContents = stashesChanged
        ? pruneStashCache(get().stashContents, stashes.length)
        : get().stashContents;
      set({
        stashes,
        stashesLoading: false,
        ...(stashesChanged ? { stashesExpanded: new Set<number>() } : {}),
        stashContents: nextContents,
      });
    } catch {
      set({ stashesLoading: false });
    }
  },

  async toggleStashExpanded(index: number) {
    const expanded = new Set(get().stashesExpanded);
    if (expanded.has(index)) {
      expanded.delete(index);
      set({ stashesExpanded: expanded });
      return;
    }
    expanded.add(index);
    set({ stashesExpanded: expanded });

    if (get().stashContents[index] !== undefined || get().stashContentsLoading.has(index)) {
      return;
    }

    const loadingSet = new Set(get().stashContentsLoading);
    loadingSet.add(index);
    set({ stashContentsLoading: loadingSet });

    try {
      const files = await bridge.request('stash/show', { index });
      const nextLoading = new Set(get().stashContentsLoading);
      nextLoading.delete(index);
      set({
        stashContents: { ...get().stashContents, [index]: files },
        stashContentsLoading: nextLoading,
      });
    } catch {
      const nextLoading = new Set(get().stashContentsLoading);
      nextLoading.delete(index);
      set({
        stashContents: { ...get().stashContents, [index]: [] },
        stashContentsLoading: nextLoading,
      });
    }
  },

  async applyStash(index: number) {
    return useOperationStore.getState().runAction({ action: 'stash-apply', index });
  },

  async dropStash(index: number) {
    return useOperationStore.getState().runAction({ action: 'stash-drop', index });
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
    // While amending, the box holds the HEAD message. Persist the pre-amend draft
    // instead, so hiding and showing the webview with amend off does not
    // resurrect a message the user never typed.
    saveState({ commitMessage: get().amend ? (get().amendDraft ?? '') : message });
  },

  setPushAfterCommit(value) {
    set({ pushAfterCommit: value });
    saveState({ pushAfterCommit: value });
  },

  async setAmend(on) {
    if (!on) {
      const base = get().amendBase;
      const restore = base !== null && get().commitMessage === base.message;
      const nextMessage = restore ? (get().amendDraft ?? '') : get().commitMessage;
      set({
        amend: false,
        amendBase: null,
        amendDraft: null,
        ...(restore ? { commitMessage: nextMessage } : {}),
      });
      // Persist what the box now shows. Without this the stored value stays at
      // the pre-amend draft, and a rebuild (`retainContextWhenHidden: false`)
      // silently drops an edit made while amending.
      saveState({ commitMessage: nextMessage });
      return;
    }

    const status = useRepoStore.getState().status;
    if (status === null || status.head === null || amendBlockedReason(status) !== null) return;
    const hash = status.head;

    set({ amend: true, amendDraft: get().commitMessage });
    try {
      const detail: CommitDetail = await bridge.request('commits/detail', { hash });
      // The user may have toggled off while the request was in flight, or HEAD
      // may have moved on to a newer commit. Either way this response describes
      // a commit the form no longer amends, so it must not become the base.
      if (!get().amend || useRepoStore.getState().status?.head !== hash) return;
      const message = joinCommitMessage(detail.subject, detail.body);
      set({
        amendBase: {
          hash: detail.hash,
          shortHash: detail.shortHash,
          subject: detail.subject,
          message,
        },
        ...(get().commitMessage.trim().length === 0 ? { commitMessage: message } : {}),
      });
    } catch (err) {
      set({ amend: false, amendDraft: null, amendBase: null });
      useOperationStore.getState().fail(err);
    }
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
    set({ busy: true, busyKind: 'commit', messageError: null });
    const ops = useOperationStore.getState();
    try {
      const token = await freshToken();
      // The payload carries no hash, so git amends whatever HEAD is now. When
      // HEAD moved since the base was captured, that would rewrite a commit the
      // note never named: refuse, drop amend mode, and say why.
      const base = get().amendBase;
      if (get().amend && base !== null && useRepoStore.getState().status?.head !== base.hash) {
        set({ busy: false, busyKind: null, amend: false, amendBase: null, amendDraft: null });
        ops.pushToast({ level: 'warning', message: strings.commitForm.amendStale });
        return false;
      }
      // `statusToken` rides in the meta, not the payload: it is part of
      // `MutationMeta` now that every mutation kind honours it.
      const handle = mutation('actions/commit', {
        message,
        push: get().pushAfterCommit,
        ...(get().amend ? { amend: true } : {}),
      });
      const result: CommitResult = await handle.send({ statusToken: token });
      set({
        busy: false,
        busyKind: null,
        commitMessage: '',
        selection: new Set<string>(),
        amend: false,
        amendBase: null,
        amendDraft: null,
      });
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
      set({ busy: false, busyKind: null });
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
  set({ busy: true, busyKind: 'stage' });
  try {
    const token = await freshToken();
    await mutation('actions/stage', { paths, stage }).send({ statusToken: token });
    set({ busy: false, busyKind: null });
    await get().load();
    await useRepoStore.getState().loadStatus();
  } catch (err) {
    set({ busy: false, busyKind: null });
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
 * `useSettingsStore` field: the value arrives via `event/iconThemeChanged`
 * (runtime theme switches) and via a `iconTheme/get` PULL on mount — the pull
 * is what closes the race where the mount-time push fires before this store's
 * listeners are wired. Never persisted or mutated by the webview; changes on a
 * different cadence (theme/extension install) than settings. Icons are the
 * only consumers.
 */
export interface IconThemeState {
  snapshot: IconThemeSnapshot | null;
  /** Pull the host's snapshot. Called on mount, after `wireHostEvents()`. */
  load(): Promise<void>;
}

export const useIconThemeStore = create<IconThemeState>((set) => ({
  snapshot: null,

  async load() {
    try {
      const snapshot = await bridge.request('iconTheme/get', {});
      set({ snapshot });
    } catch {
      // Icons are decorative; generic fallbacks keep the view usable.
    }
  },
}));

// -------------------------------------------------------------- routeStore

/**
 * Which sidebar view is active. Plumbing only: nothing renders it yet.
 *
 * `navigate` persists (webview `getState` is the only copy, D-16); `hydrate` does
 * not, because restoring the saved route must not rewrite it.
 */
export interface RouteState {
  route: Route;
  pendingFocus: FocusTarget | null;
  navigate(route: Route): void;
  navigateWithFocus(route: Route, focus: FocusTarget | null): void;
  takeFocus(): FocusTarget | null;
  hydrate(route: Route): void;
  /**
   * Pull the route queued by the host, if any. Called on mount after
   * `wireHostEvents()`. Never overwrites with "nothing queued", so a route
   * delivered by event while the request was in flight is kept.
   */
  pullPending(): Promise<void>;
}

export const useRouteStore = create<RouteState>((set, get) => ({
  route: DEFAULT_ROUTE,
  pendingFocus: null,

  navigate(route) {
    set({ route });
    saveState({ route });
  },

  navigateWithFocus(route, focus) {
    set({ route, pendingFocus: focus ?? null });
    saveState({ route });
  },

  takeFocus() {
    const focus = get().pendingFocus;
    set({ pendingFocus: null });
    return focus;
  },

  hydrate(route) {
    set({ route });
  },

  async pullPending() {
    try {
      const { route: pending, focus } = await bridge.request('ui/takePendingRoute', {});
      const current = get().route;
      const next = resolveInitialRoute({ pending, local: current });
      if (focus !== undefined) {
        get().navigateWithFocus(next, focus);
      } else if (!sameRoute(next, current)) {
        get().navigate(next);
      }
    } catch {
      // A route is a convenience; the restored one stays.
    }
  },
}));

// ---------------------------------------------------------------- navStore

/**
 * Counts and run state for the sidebar nav strip.
 *
 * Nothing polls here: P07, P08, and P13 push their own counts through `setCount`
 * when they fetch, so the strip stays a pure view of what the host already knows.
 */
export interface NavState {
  counts: NavCounts;
  failing: boolean;
  setCount(id: RouteId, count: number | null): void;
  setFailing(failing: boolean): void;
}

export const useNavStore = create<NavState>((set) => ({
  counts: {},
  failing: false,
  setCount(id, count) {
    set((state) => ({ counts: { ...state.counts, [id]: count } }));
  },
  setFailing(failing) {
    set({ failing });
  },
}));

// -------------------------------------------------------------- githubStore

export interface GitHubState {
  auth: GitHubAuthState | null;
  linkage: GitHubLinkage | null;
  pullRequests: PullRequestInfo[];
  /** Epoch ms of the last successful open-list read; `null` means never loaded. */
  pullRequestsLoadedAt: number | null;
  closedPullRequests: PullRequestInfo[];
  /** Set once the closed list was fetched; a failed fetch leaves it false so a later expand retries. */
  closedLoaded: boolean;
  avatars: Record<string, string | null>;
  rateLimit: GitHubRateLimit | null;
  loading: boolean;
  /** Set when GitHub itself failed; git keeps working regardless. */
  error: ErrorBody | null;
  load(): Promise<void>;
  /**
   * Re-read auth and linkage only, for `event/repoChanged`.
   *
   * The watcher fires on every save, so this path must not fetch a list: the
   * views already reload on activation while stale. It does have to notice a
   * repository switch, which is what clears the per-repository slices.
   */
  refreshLinkage(): Promise<void>;
  loadPullRequests(opts?: { refresh?: boolean }): Promise<void>;
  loadClosedPullRequests(): Promise<void>;
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

/** One `load()` in flight at a time; the sidebar shell and the PR view mount in one tick. */
let inFlightLoad: Promise<void> | null = null;
let inFlightPullRequests: Promise<void> | null = null;
let inFlightClosedPullRequests: Promise<void> | null = null;
let inFlightLinkage: Promise<void> | null = null;

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
  pullRequestsLoadedAt: null,
  closedPullRequests: [],
  closedLoaded: false,
  avatars: {},
  rateLimit: null,
  loading: false,
  error: null,

  async load() {
    if (inFlightLoad !== null) return inFlightLoad;
    set({ loading: true });
    inFlightLoad = (async () => {
      try {
        const [auth, linkage] = await Promise.all([
          bridge.request('github/auth', {}),
          bridge.request('github/linkage', {}),
        ]);
        const prevLinkage = get().linkage;
        const repoChanged = linkageChangedRepo(prevLinkage, linkage);
        if (repoChanged) {
          resetCommitAuthors(set);
          useIssuesStore.getState().reset();
          // Runs belong to one repository and one branch set; the next read fills them.
          useActionsStore.getState().reset();
        }
        set({
          auth,
          linkage,
          loading: false,
          error: null,
          // The previous repository's rows must not survive a `pickRepository` switch.
          ...(repoChanged
            ? {
                pullRequests: [],
                pullRequestsLoadedAt: null,
                closedPullRequests: [],
                closedLoaded: false,
              }
            : {}),
        });
        if (linkage.available) {
          await get().loadPullRequests();
          if (auth.connected) {
            void useIssuesStore.getState().load('assigned', 'open');
          }
        }
      } catch (err) {
        const body = toErrorBody(err);
        set({ loading: false, error: body });
      } finally {
        inFlightLoad = null;
      }
    })();
    return inFlightLoad;
  },

  async refreshLinkage() {
    // The watcher coalesces at 250 ms but can still fire twice in a burst; one
    // probe at a time is enough, and the second would only race the first.
    if (inFlightLinkage !== null) return inFlightLinkage;
    inFlightLinkage = (async () => {
    try {
      const [auth, linkage] = await Promise.all([
        bridge.request('github/auth', {}),
        bridge.request('github/linkage', {}),
      ]);
      const repoChanged = linkageChangedRepo(get().linkage, linkage);
      if (repoChanged) {
        resetCommitAuthors(set);
        useIssuesStore.getState().reset();
        useActionsStore.getState().reset();
      }
      set({
        auth,
        linkage,
        ...(repoChanged
          ? {
              pullRequests: [],
              pullRequestsLoadedAt: null,
              closedPullRequests: [],
              closedLoaded: false,
            }
          : {}),
      });
    } catch {
      // Linkage is metadata; a failed probe leaves the previous snapshot alone.
    } finally {
      inFlightLinkage = null;
    }
    })();
    return inFlightLinkage;
  },

  async loadPullRequests(opts?: { refresh?: boolean }) {
    if (inFlightPullRequests !== null) return inFlightPullRequests;
    const linkage = get().linkage;
    if (linkage === null || !linkage.available || linkage.owner === null || linkage.repo === null) return;
    const { owner, repo } = linkage;
    inFlightPullRequests = (async () => {
      try {
        const payload: { owner: string; repo: string; state: 'open'; refresh?: boolean } = {
          owner,
          repo,
          state: 'open',
          ...(opts?.refresh === true ? { refresh: true } : {}),
        };
        const result = await bridge.request('github/pullRequests', payload);
        set({
          pullRequests: result.pullRequests,
          pullRequestsLoadedAt: Date.now(),
          rateLimit: result.rateLimit,
          error: null,
        });
      } catch (err) {
        // Keep the previous list: stale PR chips beat an empty panel.
        const body = toErrorBody(err);
        set({ error: body });
      } finally {
        inFlightPullRequests = null;
      }
    })();
    return inFlightPullRequests;
  },

  async loadClosedPullRequests() {
    if (inFlightClosedPullRequests !== null) return inFlightClosedPullRequests;
    const { linkage, closedLoaded } = get();
    if (closedLoaded) return;
    if (linkage === null || !linkage.available || linkage.owner === null || linkage.repo === null) return;
    const { owner, repo } = linkage;
    inFlightClosedPullRequests = (async () => {
      try {
        const result = await bridge.request('github/pullRequests', { owner, repo, state: 'closed' });
        set({
          closedPullRequests: result.pullRequests,
          closedLoaded: true,
          rateLimit: result.rateLimit,
          error: null,
        });
      } catch (err) {
        // Leave `closedLoaded` false so the next expand can retry.
        const body = toErrorBody(err);
        set({ error: body });
      } finally {
        inFlightClosedPullRequests = null;
      }
    })();
    return inFlightClosedPullRequests;
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
          const body = toErrorBody(err);
          set({ error: body });
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
      const body = toErrorBody(err);
      set({ error: body });
    }
  },

  async disconnect() {
    try {
      const auth = await bridge.request('github/disconnect', {});
      resetCommitAuthors(set);
      useIssuesStore.getState().reset();
      set({
        auth,
        pullRequests: [],
        pullRequestsLoadedAt: null,
        closedPullRequests: [],
        closedLoaded: false,
        rateLimit: null,
        error: null,
      });

    } catch (err) {
      const body = toErrorBody(err);
      set({ error: body });
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

// -------------------------------------------------------------- issuesStore

export interface IssuesState {
  /** Rows for the current selection only. */
  issues: IssueInfo[];
  /** filter -> state -> rows */
  issuesByFilter: Record<IssueListFilter, Record<IssueStateFilter, IssueInfo[]>>;
  /** filter -> state -> epoch ms of the last successful read */
  loadedAt: Record<IssueListFilter, Record<IssueStateFilter, number | null>>;
  filter: IssueListFilter;
  state: IssueStateFilter;
  loading: boolean;
  error: ErrorBody | null;
  /** Change the selection and show its cached rows, or an empty list. No request. */
  select(filter: IssueListFilter, state?: IssueStateFilter): void;
  load(filter: IssueListFilter, state: IssueStateFilter, force?: boolean): Promise<void>;
  reset(): void;
}

function emptyGrid(): Record<IssueListFilter, Record<IssueStateFilter, IssueInfo[]>> {
  return {
    assigned: { open: [], closed: [] },
    created: { open: [], closed: [] },
    mentioned: { open: [], closed: [] },
  };
}

function emptyStamps(): Record<IssueListFilter, Record<IssueStateFilter, number | null>> {
  return {
    assigned: { open: null, closed: null },
    created: { open: null, closed: null },
    mentioned: { open: null, closed: null },
  };
}

/** Keyed by `${filter}:${state}`, so the open and closed reads never share a slot. */
const inFlightIssues = new Map<string, Promise<void>>();

export const useIssuesStore = create<IssuesState>((set, get) => ({
  issues: [],
  issuesByFilter: emptyGrid(),
  loadedAt: emptyStamps(),
  filter: loadState().issueFilter,
  state: 'open',
  loading: false,
  error: null,

  select(filter, state = get().state) {
    set({
      filter,
      state,
      issues: get().issuesByFilter[filter]?.[state] ?? [],
      error: null,
    });
  },

  async load(filter, state, force = false) {
    const key = `${filter}:${state}`;
    const inFlight = inFlightIssues.get(key);
    if (inFlight !== undefined) return inFlight;
    const auth = useGitHubStore.getState().auth;
    if (auth?.connected !== true) return;
    const linkage = useGitHubStore.getState().linkage;
    if (!linkage || !linkage.available || !linkage.owner || !linkage.repo) return;
    const { owner, repo } = linkage;
    const stamp = get().loadedAt[filter][state];
    if (!force && stamp !== null && Date.now() - stamp <= 60_000) {
      // A cache hit still has to repaint: the rendered rows follow the selection.
      get().select(filter, state);
      return;
    }
    set({ loading: true });
    const promise = (async () => {
      try {
        const result = await bridge.request('github/issues', { owner, repo, filter, state });
        set((s) => {
          const nextByFilter = {
            ...s.issuesByFilter,
            [filter]: { ...s.issuesByFilter[filter], [state]: result.issues },
          };
          const nextLoadedAt = {
            ...s.loadedAt,
            [filter]: { ...s.loadedAt[filter], [state]: Date.now() },
          };
          // Only repaint when the reply still matches the live selection.
          const stillSelected = s.filter === filter && s.state === state;
          return {
            issuesByFilter: nextByFilter,
            loadedAt: nextLoadedAt,
            loading: false,
            error: null,
            ...(stillSelected ? { issues: result.issues } : {}),
          };
        });
        useGitHubStore.setState({ rateLimit: result.rateLimit });
        if (filter === 'assigned' && state === 'open') {
          useNavStore.getState().setCount('issues', result.issues.length);
        }
      } catch (err) {
        set({ loading: false, error: toErrorBody(err) });
      } finally {
        inFlightIssues.delete(key);
      }
    })();
    inFlightIssues.set(key, promise);
    return promise;
  },

  reset() {
    inFlightIssues.clear();
    set({
      issues: [],
      issuesByFilter: emptyGrid(),
      loadedAt: emptyStamps(),
      filter: 'assigned',
      state: 'open',
      loading: false,
      error: null,
    });
    useNavStore.getState().setCount('issues', null);
  },
}));

// ------------------------------------------------------------- actionsStore

/**
 * Actions view slice (P13).
 *
 * Runs are keyed by the filter that produced them, not merged into one list: a
 * reply for a branch the user has already left must not repaint the list under
 * the new heading, the same rule the Issues slice follows.
 */
/**
 * One job's log as the UI reads it. `loading` and `error` are view states, not
 * protocol states: the host answers `ok`, `empty`, `expired`, `tooLarge`,
 * `binary`, or `blocked`.
 */
export interface LogEntry {
  state: LogState | 'loading' | 'error';
  lines: LogLine[];
  headCut: boolean;
}

export interface ActionsState {
  runs: WorkflowRunInfo[];
  workflows: WorkflowInfo[];
  /** filter -> rows, so a filter switch repaints without a request. */
  runsByFilter: Record<string, WorkflowRunInfo[]>;
  /** filter -> epoch ms of the last successful read. */
  loadedAt: Record<string, number>;
  branch: string | null;
  workflowId: number | null;
  expanded: Set<number>;
  jobsByRun: Record<number, RunJobInfo[]>;
  jobsLoading: Set<number>;
  jobsError: Set<number>;
  /** Job id -> processed tail. Cleared on a repository switch. */
  logs: Record<number, LogEntry>;
  /** Jobs whose log panel is open. */
  expandedJobs: Set<number>;
  loading: boolean;
  error: ErrorBody | null;
  load(opts: { branch?: string | null; workflowId?: number | null; force?: boolean }): Promise<void>;
  loadJobs(runId: number): Promise<void>;
  /** Idempotent per job id: a second call for a loaded tail sends nothing. */
  loadLog(jobId: number, opts?: { completed?: boolean }): Promise<void>;
  toggleRun(runId: number): void;
  toggleJob(jobId: number): void;
  selectBranch(branch: string | null): void;
  selectWorkflow(workflowId: number | null): void;
  /** Bounded dot refresh: five rows, current branch only, never while signed out. */
  refreshDot(branch: string | null): Promise<void>;
  reset(): void;
}

/** `per_page` for the list. 30 matches the phase contract; the cap is 50. */
export const ACTIONS_PAGE_SIZE = 30;
/** The dot only needs the newest few rows. */
const DOT_PAGE_SIZE = 5;
const ACTIONS_STALE_MS = 60_000;

const inFlightActions = new Map<string, Promise<void>>();
const inFlightJobs = new Map<number, Promise<void>>();
const inFlightLogs = new Map<number, Promise<void>>();
let inFlightDot: Promise<void> | null = null;
/** Bumped by  so a reply for the previous repository is discarded. */
let actionsGeneration = 0;

function actionsFilterKey(branch: string | null, workflowId: number | null): string {
  return `${branch ?? '*'}:${workflowId ?? '*'}`;
}

export const useActionsStore = create<ActionsState>((set, get) => {
  const initial = loadState();
  return {
    runs: [],
    workflows: [],
    runsByFilter: {},
    loadedAt: {},
    branch: initial.actionsBranch,
    workflowId: initial.actionsWorkflow,
    expanded: new Set<number>(),
    jobsByRun: {},
    jobsLoading: new Set<number>(),
    jobsError: new Set<number>(),
    logs: {},
    expandedJobs: new Set<number>(),
    loading: false,
    error: null,

    async load(opts) {
      const branch = opts.branch === undefined ? get().branch : opts.branch;
      const workflowId = opts.workflowId === undefined ? get().workflowId : opts.workflowId;
      const key = actionsFilterKey(branch, workflowId);
      // The selection is applied here, before any await: one place decides what
      // the list is showing, so a reply can be matched against it afterwards.
      set({ branch, workflowId });
      const inFlight = inFlightActions.get(key);
      if (inFlight !== undefined) return inFlight;

      const auth = useGitHubStore.getState().auth;
      if (auth?.connected !== true) return;
      const linkage = useGitHubStore.getState().linkage;
      if (!linkage || !linkage.available || !linkage.owner || !linkage.repo) return;
      const { owner, repo } = linkage;

      const stamp = get().loadedAt[key];
      if (opts.force !== true && stamp !== undefined && Date.now() - stamp <= ACTIONS_STALE_MS) {
        set({ runs: get().runsByFilter[key] ?? [], branch, workflowId, error: null });
        return;
      }

      set({ loading: true });
      // A read can outlive the repository it was asked about: `reset()` bumps the
      // generation, and `stillSelected` cannot catch that because reset keeps the
      // persisted filter. Without this guard the old reply repaints the new
      // repository's rows and seeds its cache with the previous owner's data.
      const generation = actionsGeneration;
      const promise = (async () => {
        try {
          const result = await bridge.request('github/actionsRuns', {
            owner,
            repo,
            ...(branch === null ? {} : { branch }),
            ...(workflowId === null ? {} : { workflowId }),
            perPage: ACTIONS_PAGE_SIZE,
          });
          if (generation !== actionsGeneration) return;
          set((s) => {
            const stillSelected = s.branch === branch && s.workflowId === workflowId;
            return {
              runsByFilter: { ...s.runsByFilter, [key]: result.runs },
              loadedAt: { ...s.loadedAt, [key]: Date.now() },
              loading: false,
              error: null,
              ...(stillSelected ? { runs: result.runs } : {}),
              // The workflow list only arrives on an unfiltered read; keep the last one.
              ...(result.workflows.length > 0 ? { workflows: result.workflows } : {}),
            };
          });
          useGitHubStore.setState({ rateLimit: result.rateLimit });
          // The dot is about the branch the user is on, which only an unfiltered
          // read (branch filter null) can answer: a filter on some other branch
          // must not move it.
          const repoBranch = useRepoStore.getState().status?.branch ?? null;
          if (branch === null && repoBranch !== null) {
            useNavStore.getState().setFailing(failingDot(result.runs, repoBranch));
          }
        } catch (err) {
          if (generation !== actionsGeneration) return;
          set({ loading: false, error: toErrorBody(err) });
        } finally {
          inFlightActions.delete(key);
        }
      })();
      inFlightActions.set(key, promise);
      return promise;
    },

    async loadJobs(runId) {
      if (get().jobsByRun[runId] !== undefined) return;
      const inFlight = inFlightJobs.get(runId);
      if (inFlight !== undefined) return inFlight;
      const linkage = useGitHubStore.getState().linkage;
      if (!linkage || !linkage.available || !linkage.owner || !linkage.repo) return;
      const { owner, repo } = linkage;
      set((s) => ({ jobsLoading: new Set(s.jobsLoading).add(runId) }));
      const promise = (async () => {
        try {
          const result = await bridge.request('github/actionsJobs', { owner, repo, runId });
          const failed = firstFailedJob(result.jobs);
          set((s) => ({
            jobsByRun: { ...s.jobsByRun, [runId]: result.jobs },
            jobsLoading: without(s.jobsLoading, runId),
            jobsError: without(s.jobsError, runId),
            // D-P14-3: opening a run lands on the reason it broke. User-initiated,
            // so it costs one extra read only when a failed job exists.
            ...(failed === null
              ? {}
              : { expandedJobs: new Set(s.expandedJobs).add(failed.id) }),
          }));
          useGitHubStore.setState({ rateLimit: result.rateLimit });
        } catch {
          // A failed expand keeps the row usable; the message sits under it.
          set((s) => ({
            jobsLoading: without(s.jobsLoading, runId),
            jobsError: new Set(s.jobsError).add(runId),
          }));
        } finally {
          inFlightJobs.delete(runId);
        }
      })();
      inFlightJobs.set(runId, promise);
      return promise;
    },

    toggleRun(runId) {
      set((s) => {
        const next = new Set(s.expanded);
        if (next.has(runId)) next.delete(runId);
        else next.add(runId);
        return { expanded: next };
      });
    },

    async loadLog(jobId, opts) {
      const existing = get().logs[jobId];
      // A tail is final once it loaded. `error` is retryable; every other state
      // is the answer, and asking again would only spend a request to hear it.
      if (existing !== undefined && existing.state !== 'error') return;
      const inFlight = inFlightLogs.get(jobId);
      if (inFlight !== undefined) return inFlight;
      const auth = useGitHubStore.getState().auth;
      if (auth?.connected !== true) return;
      const linkage = useGitHubStore.getState().linkage;
      if (!linkage || !linkage.available || !linkage.owner || !linkage.repo) return;
      const { owner, repo } = linkage;
      set((s) => ({
        logs: { ...s.logs, [jobId]: { state: 'loading', lines: [], headCut: false } },
      }));
      const generation = actionsGeneration;
      const promise = (async () => {
        try {
          const result = await bridge.request('github/actionsLog', {
            owner,
            repo,
            jobId,
            ...(opts?.completed === true ? { completed: true } : {}),
          });
          if (generation !== actionsGeneration) return;
          set((s) => ({
            logs: {
              ...s.logs,
              [jobId]: { state: result.state, lines: result.lines, headCut: result.headCut },
            },
          }));
          useGitHubStore.setState({ rateLimit: result.rateLimit });
        } catch {
          if (generation !== actionsGeneration) return;
          set((s) => ({
            logs: { ...s.logs, [jobId]: { state: 'error', lines: [], headCut: false } },
          }));
        } finally {
          inFlightLogs.delete(jobId);
        }
      })();
      inFlightLogs.set(jobId, promise);
      return promise;
    },

    toggleJob(jobId) {
      set((s) => {
        const next = new Set(s.expandedJobs);
        if (next.has(jobId)) next.delete(jobId);
        else next.add(jobId);
        return { expandedJobs: next };
      });
    },

    selectBranch(branch) {
      set({ branch });
      saveState({ actionsBranch: branch });
      void get().load({ branch });
    },

    selectWorkflow(workflowId) {
      set({ workflowId });
      saveState({ actionsWorkflow: workflowId });
      void get().load({ workflowId });
    },

    async refreshDot(branch) {
      if (branch === null || inFlightDot !== null) return inFlightDot ?? undefined;
      const auth = useGitHubStore.getState().auth;
      if (auth?.connected !== true) return;
      const linkage = useGitHubStore.getState().linkage;
      if (!linkage || !linkage.available || !linkage.owner || !linkage.repo) return;
      const { owner, repo } = linkage;
      // A probe can outlive the repository it was asked about. `reset()` bumps the
      // generation, so a reply that lands after a switch is dropped instead of
      // repainting the new repository's dot with the old repository's verdict.
      const generation = actionsGeneration;
      inFlightDot = (async () => {
        try {
          const result = await bridge.request('github/actionsRuns', {
            owner,
            repo,
            branch,
            perPage: DOT_PAGE_SIZE,
          });
          if (generation !== actionsGeneration) return;
          useNavStore.getState().setFailing(failingDot(result.runs, branch));
        } catch {
          // A dot is decoration: a failed probe leaves the last verdict in place.
        } finally {
          inFlightDot = null;
        }
      })();
      return inFlightDot;
    },

    reset() {
      actionsGeneration += 1;
      inFlightActions.clear();
      inFlightJobs.clear();
      inFlightLogs.clear();
      inFlightDot = null;
      set({
        runs: [],
        workflows: [],
        runsByFilter: {},
        loadedAt: {},
        expanded: new Set<number>(),
        jobsByRun: {},
        jobsLoading: new Set<number>(),
        jobsError: new Set<number>(),
        logs: {},
        expandedJobs: new Set<number>(),
        loading: false,
        error: null,
      });
      useNavStore.getState().setFailing(false);
    },
  };
});

/** Copy of `set` without `value`. Sets are compared by identity, so never mutate one. */
function without<T>(set: ReadonlySet<T>, value: T): Set<T> {
  const next = new Set(set);
  next.delete(value);
  return next;
}

// ------------------------------------------------------------ branchesStore

export interface BranchesState {
  refs: BranchRef[];
  base: string | null;
  worktrees: WorktreeInfo[];
  sort: BranchSort;
  filter: string;
  collapsed: Set<BranchesSectionKey>;
  loading: boolean;
  error: ErrorBody | null;
  load(): Promise<void>;
  setSort(sort: BranchSort): void;
  setFilter(text: string): void;
  toggleSection(key: BranchesSectionKey): void;
}

let inFlightBranchesLoad: Promise<void> | null = null;

export const useBranchesStore = create<BranchesState>((set, get) => {
  const initial = loadState();
  return {
    refs: [],
    base: null,
    worktrees: [],
    sort: initial.branchSort,
    filter: '',
    collapsed: new Set(initial.collapsedBranchSections),
    loading: false,
    error: null,
    load(): Promise<void> {
      if (inFlightBranchesLoad !== null) return inFlightBranchesLoad;
      set({ loading: true });
      inFlightBranchesLoad = (async () => {
        try {
          const [refsResult, worktreesResult] = await Promise.all([
            bridge.request('repos/refs', {}),
            bridge.request('repos/worktrees', {}),
          ]);
          set({
            refs: refsResult.refs,
            base: refsResult.base,
            worktrees: worktreesResult.worktrees,
            loading: false,
            error: null,
          });
        } catch (err) {
          // Keep previous refs and worktrees on failure so the list does not blank.
          set({ loading: false, error: toErrorBody(err) });
        } finally {
          inFlightBranchesLoad = null;
        }
      })();
      return inFlightBranchesLoad;
    },
    setSort(sort: BranchSort) {
      set({ sort });
      saveState({ branchSort: sort });
    },
    setFilter(text: string) {
      set({ filter: text });
    },
    toggleSection(key: BranchesSectionKey) {
      const next = new Set(get().collapsed);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      set({ collapsed: next });
      saveState({ collapsedBranchSections: [...next] });
    },
  };
});

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
        void useGitHubStore.getState().refreshLinkage();
        void useChangesStore.getState().load();
        void useRepoStore.getState().refresh();
        // Refs and worktrees move with the repository too, so an open Branches
        // view would otherwise show a stale list after a checkout made
        // elsewhere. Guarded by the route: reading refs costs two git spawns and
        // nothing else on this panel displays them.
        if (useRouteStore.getState().route.id === 'branches') {
          void useBranchesStore.getState().load();
        }
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

  const offCommitFocus = bridge.on('event/commitFocus', (payload) => {
    useRepoStore.getState().focusCommit(payload.hash);
  });

  // The explorer has no sidebar route, so it does not subscribe.
  const offNavigate =
    mode === 'pending'
      ? bridge.on('event/navigate', (payload) => {
          useRouteStore.getState().navigateWithFocus(payload.route, payload.focus ?? null);
          // Clear the host's queued copy so the next mount does not replay a delivered route.
          void bridge.request('ui/takePendingRoute', {}).catch(() => undefined);
        })
      : undefined;

  return () => {
    offChanged();
    offProgress();
    offToast();
    offSettings();
    offIconTheme();
    offCommitFocus();
    offNavigate?.();
    wired = false;
  };
}

/** Re-export so components do not import the bridge module directly. */
export { BridgeRequestError };
