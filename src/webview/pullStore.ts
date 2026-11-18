/**
 * Pull request detail store (P24).
 *
 * The panel is rebuilt whenever its tab is revealed (`retainContextWhenHidden:
 * false`), so nothing here may be the only copy of a fact: the detail and each
 * tab's data are re-read on mount, and only the active tab is read at all.
 *
 * Lazy loading is the rate-limit story, not an optimisation: a pull request open
 * costs one read plus one per tab the user actually visits.
 */
import { create } from 'zustand';
import { bridge, loadState, saveState } from './bridge';
import { pullTabIds, type PullTab } from './pullView';
import { toErrorBody, useOperationStore } from './store';
import type {
  CheckRunInfo,
  CheckSummary,
  ErrorBody,
  PullCommit,
  PullDetail,
  PullDetailPayload,
  PullFile,
  TimelineItem,
} from '../messages';

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
  load(payload: PullDetailPayload): Promise<void>;
  setTab(tab: PullTab): void;
  loadTab(tab: PullTab): Promise<void>;
}

/** The payload of the last `load`, so `loadTab` can ask for the same pull request. */
let target: PullDetailPayload | null = null;

/**
 * Bumped on every `load`. A tab reply that arrives after the panel switched to
 * another pull request must not paint one repository's data over another's.
 */
let generation = 0;

/** Tabs with a request in flight, so reselecting one does not send a second. */
const inFlight = new Set<PullTab>();

function toastFailure(err: unknown): void {
  const body = toErrorBody(err);
  useOperationStore.getState().pushToast({
    level: body.code === 'UNAVAILABLE' ? 'warning' : 'error',
    message: body.message,
    ...(body.detail === undefined ? {} : { detail: body.detail }),
  });
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
}));

/** The tab the host persisted for this webview, or the first tab. */
export function initialPullTab(): PullTab {
  return loadState().prTab;
}
