/**
 * Pull request detail store (P24).
 *
 * The panel is rebuilt whenever its tab is revealed (`retainContextWhenHidden:
 * false`), so nothing here may be the only copy of a fact: the detail and each
 * tab's data are re-read on mount, and only the active tab is read at all.
 *
 * Lazy loading is the rate-limit story, not an optimisation: a pull request open
 * costs one read plus one per tab the user actually visits.
 *
 * P25 adds the writes: merge, review, reply, and close. A merge keeps one
 * idempotency key from the confirm dialog through a retry, so a double click
 * lands one merge; a refusal is a state the panel explains, not a toast.
 */
import { create } from 'zustand';
import { bridge, loadState, saveState } from './bridge';
import { pullTabIds, type PullTab } from './pullView';
import { mergeBlockReason, type BlockReason, type MergeMethod } from './pullMerge';
import { activeLang, t } from './i18n';
import { toErrorBody, useGitHubStore, useOperationStore } from './store';
import type {
  CheckRunInfo,
  MergePullResult,
  CheckSummary,
  ErrorBody,
  PullCommit,
  PullDetail,
  PullDetailPayload,
  PullFile,
  ReviewEvent,
  TimelineItem,
} from '../messages';

/** The merge state machine. A refusal is a state the panel explains. */
export type PullMergeState = 'idle' | 'confirm' | 'merging' | 'merged' | 'failed';

export interface PullState {
  detail: PullDetail | null;
  commits: PullCommit[] | null;
  files: { files: PullFile[]; mergeBase: string | null } | null;
  timeline: TimelineItem[] | null;
  /** The badge's summary. `null` until the Checks tab is visited. */
  checks: CheckSummary | null;
  /** The runs behind the summary, kept separately because the tab lists them. */
  checkRuns: CheckRunInfo[] | null;
  tab: PullTab;
  loading: boolean;
  error: ErrorBody | null;
  truncated: { commits: boolean; files: boolean; timeline: boolean };
  /** P25 merge state machine. A refusal is a state the panel explains, not a toast. */
  mergeState: PullMergeState;
  mergeError: ErrorBody | null;
  /** The successful result, so the merged card can name the sha and the deletions. */
  mergeResult: MergePullResult | null;
  /** P25 review submit state. The dialog owns the text, so none is kept here. */
  reviewState: 'idle' | 'sending' | 'failed';
  reviewError: ErrorBody | null;
  load(payload: PullDetailPayload): Promise<void>;
  setTab(tab: PullTab): void;
  loadTab(tab: PullTab): Promise<void>;
  /** Open the confirmation dialog. Mints the merge's idempotency key; sends nothing. */
  openMerge(): void;
  cancelMerge(): void;
  merge(options: MergeInput): Promise<void>;
  /** Repeat the failed attempt with the same key, so the host replays it. */
  retryMerge(): Promise<void>;
  review(input: { event: ReviewEvent; body: string }): Promise<void>;
  reply(commentId: number, body: string): Promise<void>;
  close(): Promise<void>;
}

/** The confirmed merge attempt. `merge()` and its retry both send this unchanged. */
export interface MergeInput {
  method: MergeMethod;
  commitTitle?: string;
  commitMessage?: string;
  deleteBranch?: boolean;
}

/** No checks read yet: nothing failing or pending, so only the PR state can block. */
const EMPTY_CHECKS: CheckSummary = {
  state: 'none',
  total: 0,
  passed: 0,
  failing: 0,
  pending: 0,
  failingNames: [],
};

/** The payload of the last `load`, so `loadTab` can ask for the same pull request. */
let target: PullDetailPayload | null = null;

/**
 * Bumped on every `load`. A tab reply that arrives after the panel switched to
 * another pull request must not paint one repository's data over another's.
 */
let generation = 0;

/** Tabs with a request in flight, so reselecting one does not send a second. */
const inFlight = new Set<PullTab>();

/**
 * The idempotency key of the current merge attempt. Minted only in `openMerge`
 * and kept across a failure, so a retry is the same logical merge; cleared once
 * it lands, so the next dialog cannot replay the first outcome.
 */
let mergeKey: string | null = null;

/** The options the confirm dialog sent, replayed verbatim by `retryMerge`. */
let mergeOptions: MergeInput | null = null;

/**
 * Point `loadTab` at the pull request whose detail is on screen. A panel that was
 * mounted by `load()` already has this; a test or a direct write does not, and a
 * conversation refresh must not silently no-op because `target` is stale or null.
 */
function pointTarget(payload: PullDetailPayload): void {
  target = payload;
}

/** Drop the cached conversation and read it again, so the new item appears. */
async function refreshConversation(
  get: () => PullState,
  set: (partial: Partial<PullState>) => void,
): Promise<void> {
  set({ timeline: null });
  await get().loadTab('conversation');
}

/**
 * Owner and repo for a write. The detail panel already knows the pull request,
 * so the linkage is preferred but not required: the panel rebuilds its store on
 * reveal while `useGitHubStore` may still be loading, and a missing linkage must
 * not turn a visible merge button into a dead one. `htmlUrl` is the same source
 * the panel renders links from, so it is trustworthy for the slug pair.
 */
function repoOf(): { owner: string; repo: string } | null {
  const linkage = useGitHubStore.getState().linkage;
  if (linkage !== null && linkage.available && linkage.owner !== null && linkage.repo !== null) {
    return { owner: linkage.owner, repo: linkage.repo };
  }
  const htmlUrl = usePullStore.getState().detail?.htmlUrl ?? '';
  const match = /^https?:\/\/[^/]+\/([^/]+)\/([^/]+)\/pull\/\d+$/.exec(htmlUrl);
  if (match === null) return null;
  return { owner: match[1] as string, repo: match[2] as string };
}

function toastFailure(err: unknown): void {
  const body = asErrorBody(err);
  toastBody(body);
}

function toastBody(body: ErrorBody): void {
  useOperationStore.getState().pushToast({
    level: body.code === 'UNAVAILABLE' ? 'warning' : 'error',
    message: body.message,
    ...(body.detail === undefined ? {} : { detail: body.detail }),
  });
}

/**
 * A rejection may carry an `ErrorBody` without being a `BridgeRequestError`
 * instance (the test transport, and any plain rethrow), so read `body` first.
 * Same fallback as `usePrDraftStore.submit`.
 */
function asErrorBody(err: unknown): ErrorBody {
  return (err as { body?: ErrorBody } | null)?.body ?? toErrorBody(err);
}

/** A refusal the panel states as a line, not a toast: the reason is the message. */
function blockedBody(reason: BlockReason): ErrorBody {
  return {
    status: 409,
    code: 'CONFLICT',
    message: t(activeLang()).prMerge.blocked[reason],
    detail: reason,
  };
}

/** No repository slug to write to. Reachable only before linkage and detail agree. */
function unavailableBody(): ErrorBody {
  return {
    status: 503,
    code: 'UNAVAILABLE',
    message: t(activeLang()).prs.noRemoteBody,
    detail: 'owner/repo',
  };
}

export const usePullStore = create<PullState>((set, get) => ({
  detail: null,
  commits: null,
  files: null,
  timeline: null,
  checks: null,
  checkRuns: null,
  tab: 'conversation',
  loading: false,
  error: null,
  truncated: { commits: false, files: false, timeline: false },
  mergeState: 'idle',
  mergeError: null,
  mergeResult: null,
  reviewState: 'idle',
  reviewError: null,

  async load(payload) {
    const mine = ++generation;
    target = payload;
    inFlight.clear();
    // Every other field starts empty: a rebuilt panel must not draw the previous
    // number's commits under this number's title while the read is in flight.
    set({
      detail: null,
      commits: null,
      files: null,
      timeline: null,
      checks: null,
      checkRuns: null,
      loading: true,
      error: null,
      truncated: { commits: false, files: false, timeline: false },
    });
    try {
      const result = await bridge.request('github/pullDetail', payload);
      if (mine !== generation) return;
      set({ detail: result.detail, loading: false });
    } catch (err) {
      if (mine !== generation) return;
      set({ error: toErrorBody(err), loading: false });
    }
  },

  setTab(tab) {
    if (!pullTabIds.includes(tab)) return;
    set({ tab });
    // Only the tab rides in host state: the data is cheap to re-read and a stale
    // cache would outlive the pull request it describes.
    saveState({ prTab: tab });
  },

  async loadTab(tab) {
    const payload = target;
    const detail = get().detail;
    if (payload === null || detail === null) return;
    if (inFlight.has(tab)) return;
    const mine = generation;

    switch (tab) {
      case 'conversation': {
        if (get().timeline !== null) return;
        inFlight.add(tab);
        try {
          const result = await bridge.request('github/pullTimeline', payload);
          if (mine !== generation) return;
          set({
            timeline: result.items,
            truncated: { ...get().truncated, timeline: result.truncated },
          });
        } catch (err) {
          if (mine === generation) toastFailure(err);
        } finally {
          inFlight.delete(tab);
        }
        return;
      }
      case 'commits': {
        if (get().commits !== null) return;
        inFlight.add(tab);
        try {
          const result = await bridge.request('github/pullCommits', payload);
          if (mine !== generation) return;
          set({
            commits: result.commits,
            truncated: { ...get().truncated, commits: result.truncated },
          });
        } catch (err) {
          if (mine === generation) toastFailure(err);
        } finally {
          inFlight.delete(tab);
        }
        return;
      }
      case 'checks': {
        if (get().checkRuns !== null) return;
        // A pull request detail with no head sha has no commit to ask about; the
        // check badge would spin forever, so the tab stays empty instead.
        if (detail.headSha.length === 0) return;
        inFlight.add(tab);
        try {
          const result = await bridge.request('github/checkRuns', {
            owner: payload.owner,
            repo: payload.repo,
            sha: detail.headSha,
          });
          if (mine !== generation) return;
          set({ checkRuns: result.checks, checks: result.summary });
        } catch (err) {
          if (mine === generation) toastFailure(err);
        } finally {
          inFlight.delete(tab);
        }
        return;
      }
      case 'files': {
        if (get().files !== null) return;
        inFlight.add(tab);
        try {
          const result = await bridge.request('github/pullFiles', payload);
          if (mine !== generation) return;
          set({
            files: { files: result.files, mergeBase: result.mergeBase },
            truncated: { ...get().truncated, files: result.truncated },
          });
        } catch (err) {
          if (mine === generation) toastFailure(err);
        } finally {
          inFlight.delete(tab);
        }
        return;
      }
      default:
    }
  },

  openMerge() {
    // The dialog is the level 1 confirmation, so this mints the one key the
    // attempt owns. Nothing is sent before the user confirms.
    mergeKey = crypto.randomUUID();
    mergeOptions = null;
    set({ mergeState: 'confirm', mergeError: null });
  },

  cancelMerge() {
    mergeKey = null;
    mergeOptions = null;
    set({ mergeState: 'idle', mergeError: null });
  },

  async merge(options) {
    const detail = get().detail;
    if (detail === null) return;
    // The panel's own guard, checked before any request: a dirty or draft pull
    // request never reaches the network. The host re-checks and is authoritative.
    const checks = get().checks ?? EMPTY_CHECKS;
    const blocked = mergeBlockReason(detail, checks);
    if (blocked !== null) {
      set({ mergeState: 'failed', mergeError: blockedBody(blocked) });
      return;
    }
    const repo = repoOf();
    if (repo === null) {
      set({ mergeState: 'failed', mergeError: unavailableBody() });
      return;
    }
    // A retry reuses the key `openMerge` minted; a direct call still gets one.
    const key = mergeKey ?? crypto.randomUUID();
    mergeKey = key;
    // Remembered before the await so `retryMerge` can replay the same attempt.
    mergeOptions = options;
    set({ mergeState: 'merging', mergeError: null });
    try {
      const outcome = await bridge.request('github/mergePullRequest', {
        owner: repo.owner,
        repo: repo.repo,
        number: detail.number,
        method: options.method,
        expectedHeadSha: detail.headSha,
        ...(options.commitTitle === undefined ? {} : { commitTitle: options.commitTitle }),
        ...(options.commitMessage === undefined ? {} : { commitMessage: options.commitMessage }),
        ...(options.deleteBranch === undefined ? {} : { deleteBranch: options.deleteBranch }),
        idempotencyKey: key,
        // The dialog's confirm button IS the level 1 confirmation.
        confirm: true,
      });
      // Landed: forget the key so the next open cannot replay this outcome, and
      // forget the options so a stray retry has nothing to resend.
      mergeKey = null;
      mergeOptions = null;
      set({ mergeState: 'merged', mergeResult: outcome });
      await get().load({ owner: repo.owner, repo: repo.repo, number: detail.number });
      // The list row now says merged; re-read auth, linkage, and the list.
      void useGitHubStore.getState().load();
    } catch (err) {
      // Keep `mergeKey`: the retry must replay this same logical merge.
      set({ mergeState: 'failed', mergeError: asErrorBody(err) });
    }
  },

  async retryMerge() {
    const options = mergeOptions;
    if (options === null) return;
    await get().merge(options);
  },

  async review(input) {
    const detail = get().detail;
    if (detail === null) return;
    const repo = repoOf();
    if (repo === null) {
      set({ reviewState: 'failed', reviewError: unavailableBody() });
      return;
    }
    // Only once there is something to send: a return above must not leave the
    // button saying `sending` with no request behind it.
    set({ reviewState: 'sending', reviewError: null });
    pointTarget({ owner: repo.owner, repo: repo.repo, number: detail.number });
    try {
      await bridge.request('github/submitReview', {
        owner: repo.owner,
        repo: repo.repo,
        number: detail.number,
        event: input.event,
        body: input.body,
        expectedHeadSha: detail.headSha,
        // The form is the act, so no `confirm`; a fresh key per submit because
        // each submit is a distinct review, not a retry of the previous one.
        idempotencyKey: crypto.randomUUID(),
      });
      set({ reviewState: 'idle', reviewError: null });
      await refreshConversation(get, set);
    } catch (err) {
      set({ reviewState: 'failed', reviewError: asErrorBody(err) });
    }
  },

  async reply(commentId, body) {
    const detail = get().detail;
    const repo = repoOf();
    if (detail === null || repo === null) {
      toastBody(unavailableBody());
      return;
    }
    pointTarget({ owner: repo.owner, repo: repo.repo, number: detail.number });
    try {
      await bridge.request('github/replyReviewComment', {
        owner: repo.owner,
        repo: repo.repo,
        number: detail.number,
        commentId,
        body,
        idempotencyKey: crypto.randomUUID(),
      });
      await refreshConversation(get, set);
    } catch (err) {
      toastFailure(err);
    }
  },

  async close() {
    const detail = get().detail;
    const repo = repoOf();
    if (detail === null || repo === null) {
      toastBody(unavailableBody());
      return;
    }
    try {
      await bridge.request('github/closePullRequest', {
        owner: repo.owner,
        repo: repo.repo,
        number: detail.number,
        idempotencyKey: crypto.randomUUID(),
        // The menu row is the level 1 confirmation.
        confirm: true,
      });
      await get().load({ owner: repo.owner, repo: repo.repo, number: detail.number });
    } catch (err) {
      toastFailure(err);
    }
  },
}));

/** The tab the host persisted for this webview, or the first tab. */
export function initialPullTab(): PullTab {
  return loadState().prTab;
}
