/**
 * Sidebar header (Pending Changes): title row, branch row with sync chip, upstream row.
 *
 * Sidebar only. The Explorer keeps `ContextBar`. Owns no state: it reads the repo
 * stores and renders `headerModel`. Buttons land with their features (R2), so the
 * title row is a flex row that later phases append to.
 */
import type { JSX } from 'react';
import { BranchSelector } from './BranchLegend';
import { bridge } from './bridge';
import { formatCount, headerModel, sanitizeGitText, type SyncBadge } from './format';
import type { IconName } from './icons';
import {
  toErrorBody,
  useChangesStore,
  useGitHubStore,
  useOperationStore,
  useRepoStore,
  useRouteStore,
  useSettingsStore,
} from './store';
import { Icon } from './ui';
import { useT } from './useT';

const SYNC_ICON: Record<SyncBadge, IconName> = {
  local: 'cloud',
  synced: 'check',
  ahead: 'arrow-up',
  behind: 'arrow-down',
  diverged: 'merge',
};

export function SidebarHeader(): JSX.Element | null {
  const strings = useT();
  const language = useSettingsStore((s) => s.language);
  const status = useRepoStore((s) => s.status);
  const graph = useRepoStore((s) => s.graph);
  const loadStatus = useRepoStore((s) => s.loadStatus);
  const loadGraph = useRepoStore((s) => s.loadGraph);
  const load = useChangesStore((s) => s.load);
  const loading = useChangesStore((s) => s.loading);
  const busy = useChangesStore((s) => s.busy);
  const pushToast = useOperationStore((s) => s.pushToast);
  const loadPullRequests = useGitHubStore((s) => s.loadPullRequests);
  const route = useRouteStore((s) => s.route);

  const model = headerModel(status, language);
  if (status === null || model === null) return null;
  const shell = strings.shell;

  /**
   * The header reload is the only Reload the user has (the "..." menu is still
   * deferred), so it covers whichever list is on screen. On `prs` it asks the
   * host to revalidate with `If-None-Match`, which costs one conditional request
   * instead of a full payload and does not consume primary quota on a 304.
   */
  const refresh = (): void => {
    void load();
    void loadStatus();
    void loadGraph();
    if (route.id === 'prs') void loadPullRequests({ refresh: true });
  };

  const openExplorer = async (): Promise<void> => {
    try {
      await bridge.request('actions/openExplorer', {});
    } catch (err) {
      const body = toErrorBody(err);
      pushToast({
        level: body.code === 'UNAVAILABLE' ? 'warning' : 'error',
        message: body.message,
      });
    }
  };

  const openQuickActions = async (): Promise<void> => {
    try {
      await bridge.request('actions/openQuickActions', {});
    } catch (err) {
      const body = toErrorBody(err);
      pushToast({
        level: body.code === 'UNAVAILABLE' ? 'warning' : 'error',
        message: body.message,
      });
    }
  };

  const syncLabel: Record<SyncBadge, string> = {
    local: shell.syncLocal,
    synced: shell.syncSynced,
    ahead: shell.syncAhead(formatCount(model.ahead, language)),
    behind: shell.syncBehind(formatCount(model.behind, language)),
    diverged: shell.syncDiverged,
  };

  return (
    <header
      className={model.detached ? 'gc-sidebar-header gc-sidebar-header--detached' : 'gc-sidebar-header'}
      aria-label={shell.headerAria}
    >
      <div className="gc-sidebar-header__row">
        <span className="gc-sidebar-header__title" title={sanitizeGitText(status.repoRoot)}>
          {sanitizeGitText(model.title)}
        </span>
        <div className="gc-sidebar-header__actions" role="group" aria-label={shell.titleRowAria}>
          <button
            type="button"
            className="gc-icon-button"
            aria-label={strings.pending.reloadAria}
            title={strings.pending.reloadAria}
            aria-busy={loading}
            onClick={refresh}
          >
            <Icon name="refresh" />
          </button>
          <button
            type="button"
            className="gc-icon-button"
            aria-label={strings.palette.openAria}
            title={strings.palette.openTitle}
            onClick={() => void openQuickActions()}
          >
            <Icon name="search" />
          </button>
          <button
            type="button"
            className="gc-icon-button"
            aria-label={strings.pending.openGraphAria}
            title={strings.pending.openGraphAria}
            onClick={() => void openExplorer()}
          >
            <Icon name="graph" />
          </button>
        </div>
      </div>

      <div className="gc-sidebar-header__row gc-sidebar-header__branch">
        <BranchSelector
          currentBranch={status.branch}
          refs={graph?.refs ?? []}
          busy={busy || status.operation !== 'idle'}
        />
        <span
          className={`gc-chip gc-sidebar-header__sync gc-sidebar-header__sync--${model.syncBadge}`}
          title={model.syncBadge === 'local' ? shell.syncLocalTitle : model.upstreamLine}
        >
          <Icon name={SYNC_ICON[model.syncBadge]} />
          <span>{syncLabel[model.syncBadge]}</span>
        </span>
      </div>

      {/*
        The visible text is short; the full sentence and the "branch" wording stay in
        the visually hidden fallback so a screen reader hears the counts and the kind
        of name, as `ContextBar` did.
      */}
      <p className="gc-sidebar-header__upstream" title={model.upstreamLine}>
        <span className="gc-sidebar-header__upstream-visual" aria-hidden="true">
          <span className="gc-sidebar-header__upstream-text">{model.upstream ?? shell.notPublished}</span>
          {model.hash !== null && (
            <>
              <span className="gc-sidebar-header__dot">·</span>
              <code className="gc-sidebar-header__hash">{model.hash}</code>
            </>
          )}
        </span>
        <span className="gc-visually-hidden">
          {strings.ui.branchLabel(model.branchLabel)}. {model.upstreamLine}
          {model.hash !== null && ` ${strings.ui.headAtCommit(model.hash)}`}
        </span>
      </p>
    </header>
  );
}
