/**
 * Explorer sync buttons (P18b), frame 01.
 *
 * Fetch, Pull, and Push sit beside the crumbs and left of Help and More. The
 * rules and the payload shape live in `syncActions.ts`; this file only maps the
 * model to markup, so the header cannot drift from the sidebar footer
 * (`CommitForm`) that shares the same catalog entries.
 *
 * A repository with no remote shows no group at all: three dead controls would
 * explain less than their absence.
 */
import type { JSX } from 'react';
import { formatCount } from './format';
import { useChangesStore, useOperationStore, useRepoStore, useSettingsStore } from './store';
import { deriveSyncActions, syncActionRequest, type SyncButton, type SyncContext } from './syncActions';
import { Icon } from './ui';
import { useT } from './useT';
import { firstRemoteName } from './NodeContextMenu';

export function ExplorerSyncActions(): JSX.Element | null {
  const catalog = useT();
  const strings = catalog.explorerSync;
  const commit = catalog.commitForm;
  const language = useSettingsStore((st) => st.language);
  const status = useRepoStore((st) => st.status);
  const graph = useRepoStore((st) => st.graph);
  const runAction = useOperationStore((st) => st.runAction);
  const opBusy = useOperationStore((st) => st.state === 'loading');
  const changesBusy = useChangesStore((st) => st.busy);
  const busy = opBusy || changesBusy;

  // Same rule as the sidebar footer: upstream prefix first, else the first
  // remote-tracking ref, else null (and then no group renders).
  const remote =
    status?.upstream !== null && status?.upstream !== undefined
      ? status.upstream.split('/')[0] ?? null
      : firstRemoteName(graph?.refs ?? []);

  const branch = status?.branch ?? null;
  const ctx: SyncContext = {
    branch,
    upstream: status?.upstream ?? null,
    ahead: status?.ahead ?? 0,
    behind: status?.behind ?? 0,
    remote,
    busy,
  };

  const buttons = deriveSyncActions(ctx);
  if (buttons.length === 0) return null;

  const labelOf = (button: SyncButton): string => {
    if (button.id === 'fetch') return strings.fetchButton;
    if (button.id === 'pull') {
      return button.count === null
        ? commit.pullButton
        : commit.pullWithCountButton(formatCount(button.count, language));
    }
    return button.kind === 'publish'
      ? commit.publishButton
      : button.count === null
        ? commit.pushButton
        : commit.pushWithCountButton(formatCount(button.count, language));
  };

  const titleOf = (button: SyncButton): string => {
    switch (button.reason) {
      case 'busy':
        return button.id === 'fetch'
          ? strings.fetchDisabledBusy
          : button.id === 'pull'
            ? commit.pullDisabledBusy
            : commit.pushDisabledBusy;
      case 'no-branch':
        return button.id === 'pull' ? commit.pullDisabledNoBranch : commit.pushDisabledNoBranch;
      case 'no-upstream':
        return strings.pullDisabledNoUpstream;
      case 'in-sync':
        return commit.pushDisabledInSync;
      default:
    }
    // Non-disabled branches: a null remote or branch means no group renders, so
    // the empty fallbacks only keep the types clean.
    if (button.id === 'fetch') return strings.fetchTitle(remote ?? '');
    if (button.id === 'pull') return commit.pullTitle(remote ?? '', branch ?? '');
    return button.kind === 'publish'
      ? commit.publishTitle(remote ?? '', branch ?? '')
      : commit.pushTitle(remote ?? '', branch ?? '');
  };

  return (
    <div className="gc-explorer__sync" role="group" aria-label={strings.groupAria} aria-busy={busy}>
      {buttons.map((button) => {
        const label = labelOf(button);
        return (
          <button
            key={button.id}
            type="button"
            className={
              button.kind === 'publish'
                ? 'gc-explorer__sync__button gc-explorer__sync__button--accent'
                : 'gc-explorer__sync__button'
            }
            aria-label={label}
            title={titleOf(button)}
            disabled={button.disabled}
            onClick={() => {
              const request = syncActionRequest(button.id, ctx);
              if (request !== null) void runAction(request);
            }}
          >
            <Icon name={button.id === 'fetch' ? 'fetch' : button.id === 'pull' ? 'pull' : 'push'} />
            <span className="gc-explorer__sync__label">{label}</span>
            {button.count !== null && (
              <span className="gc-explorer__sync__count" aria-hidden="true">
                {formatCount(button.count, language)}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
