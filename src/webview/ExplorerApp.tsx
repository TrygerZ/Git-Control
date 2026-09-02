/**
 * Explorer root: the graph plus the inspector, conflict banner, guard dialog,
 * and toast region.
 */
import { useCallback, useEffect, useId, useState, type JSX } from 'react';
import { ConflictPanel, OperationBanner } from './ConflictPanel';
import { GitHubPanel } from './GitHubPanel';
import { GraphCanvas } from './GraphCanvas';
import { GuardDialog } from './GuardDialog';
import { Inspector } from './Inspector';
import { PromptDialog } from './PromptDialog';
import { ToastRegion } from './Toast';
import { bridge, loadState } from './bridge';
import { githubBaseUrl, type MenuItem } from './NodeContextMenu';
import { useT } from './useT';
import {
  useGitHubStore,
  useOperationStore,
  useRepoStore,
  useSettingsStore,
  wireHostEvents,
} from './store';
import { ContextBar, ErrorBanner, Icon } from './ui';
import { sanitizeGitText } from './format';
import type { GraphNode } from '../messages';

export function ExplorerApp(): JSX.Element {
  const strings = useT();
  const graph = useRepoStore((s) => s.graph);
  const status = useRepoStore((s) => s.status);
  const loading = useRepoStore((s) => s.loading);
  const paging = useRepoStore((s) => s.paging);
  const error = useRepoStore((s) => s.error);
  const selectedHash = useRepoStore((s) => s.selectedHash);
  const refresh = useRepoStore((s) => s.refresh);
  const selectCommit = useRepoStore((s) => s.selectCommit);
  const loadSettings = useSettingsStore((s) => s.load);
  const runAction = useOperationStore((s) => s.runAction);
  const pushToast = useOperationStore((s) => s.pushToast);
  const showLogs = useOperationStore((s) => s.showLogs);
  const progressLog = useOperationStore((s) => s.progressLog);
  const [createBranchTarget, setCreateBranchTarget] = useState<{
    startPoint: string;
    defaultName: string;
  } | null>(null);
  const [mergeIntoTarget, setMergeIntoTarget] = useState<{
    source: string;
    targets: readonly string[];
  } | null>(null);

  const [githubUrl, setGithubUrl] = useState<string | null>(null);
  const [inspectorOpen, setInspectorOpen] = useState(true);
  const openUrl = useGitHubStore((s) => s.openUrl);
  // `aria-controls` needs a stable id even across two roots in one bundle.
  const asideId = useId();

  useEffect(() => {
    const persisted = loadState();
    if (persisted.selectedHash !== null) selectCommit(persisted.selectedHash);
    const off = wireHostEvents('explorer');
    void loadSettings();
    void refresh();
    // The host parses each remote URL, so the GitHub item appears only when a
    // GitHub remote actually exists.
    bridge
      .request('repos/remotes', {})
      .then((result) => setGithubUrl(githubBaseUrl(result.remotes)))
      .catch(() => setGithubUrl(null));
    return off;
  }, [loadSettings, refresh, selectCommit]);

  const onMenuCommand = useCallback(
    (item: MenuItem, node: GraphNode): void => {
      const command = item.command;
      switch (command.kind) {
        case 'action':
          void runAction(command.request);
          return;
        case 'copy':
          void navigator.clipboard
            .writeText(command.text)
            .then(() => pushToast({ level: 'info', message: command.toast }))
            .catch(() =>
              pushToast({ level: 'warning', message: strings.explorer.toastCopyFailed }),
            );
          return;
        case 'viewDiff':
          selectCommit(command.hash);
          setInspectorOpen(true);
          return;
        case 'createBranch': {
          setCreateBranchTarget({
            startPoint: command.startPoint,
            defaultName: `${strings.explorer.defaultBranchPrefix}/${node.shortHash}`,
          });
          return;
        }
        case 'mergeInto': {
          setMergeIntoTarget({
            source: command.source,
            targets: command.targets,
          });
          return;
        }
        case 'openGitHub':
          // Host-side only: the webview CSP forbids navigation, and routing every
          // external link through the host keeps URL vetting in one place.
          void openUrl(command.url);
          return;
        default:
      }
    },
    [openUrl, pushToast, runAction, selectCommit, strings.explorer.defaultBranchPrefix, strings.explorer.newBranchPrompt, strings.explorer.toastCopyFailed],
  );

  // Newest commit's subject, for the context breadcrumb. Sanitised here rather than
  // inside `ContextBar`, so the one git-sourced string it receives is already safe.
  const newest = graph === null ? undefined : graph.nodes[0];
  const newestSubject = newest === undefined ? undefined : sanitizeGitText(newest.subject);

  return (
    <div className="gc-explorer">
      <ContextBar status={status} subject={newestSubject} />

      <OperationBanner status={status} />

      {error !== null && (
        <ErrorBanner
          error={error}
          onShowLogs={showLogs}
          onRemedy={(remedy) => {
            if (remedy === 'fetch') void runAction({ action: 'fetch', prune: true });
            else if (remedy === 'cancel') useRepoStore.setState({ error: null });
          }}
        />
      )}

      <div className="gc-explorer__split">
        <div className="gc-explorer__graph">
          <GraphCanvas
            graph={graph}
            status={status}
            loading={loading}
            paging={paging}
            githubUrl={githubUrl}
            onMenuCommand={onMenuCommand}
            onOpenInspector={(hash) => {
              selectCommit(hash);
              setInspectorOpen(true);
            }}
          />
        </div>

        <aside
          className={inspectorOpen ? 'gc-explorer__aside' : 'gc-explorer__aside gc-explorer__aside--closed'}
          aria-label={strings.explorer.asideAria}
        >
          <div className="gc-explorer__aside-head">
            <span className="gc-explorer__aside-title">{strings.explorer.asideTitle}</span>
            <button
              type="button"
              className="gc-icon-button gc-explorer__aside-toggle"
              aria-expanded={inspectorOpen}
              aria-controls={asideId}
              aria-label={inspectorOpen ? strings.explorer.hideDetails : strings.explorer.showDetails}
              title={inspectorOpen ? strings.explorer.hideDetails : strings.explorer.showDetails}
              onClick={() => setInspectorOpen(!inspectorOpen)}
            >
              <Icon name={inspectorOpen ? 'chevron-down' : 'chevron-right'} />
            </button>
          </div>
          <div id={asideId} className="gc-explorer__aside-content">
            {inspectorOpen && (
              <>
                <Inspector hash={selectedHash} />
                <GitHubPanel />
                {status !== null && status.conflicts.length > 0 && (
                  <ConflictPanel conflicts={status.conflicts} operation={status.operation} />
                )}
                {progressLog.length > 0 && (
                  <details className="gc-progress">
                    <summary>{strings.explorer.operationLogSummary(progressLog.length)}</summary>
                    <pre className="gc-progress__log" aria-label={strings.explorer.operationLogAria}>
                      {progressLog.join('\n')}
                    </pre>
                  </details>
                )}
              </>
            )}
          </div>
        </aside>
      </div>

      <GuardDialog />
      {createBranchTarget !== null && (
        <PromptDialog
          title={strings.explorer.createBranchTitle}
          label={strings.explorer.newBranchPrompt}
          submitLabel={strings.explorer.createBranchTitle}
          cancelLabel={strings.guard.cancelButton}
          initialValue={createBranchTarget.defaultName}
          validate={(val) => {
            // Client-side quick validation: non-empty only. Host (validateBranchName) is sole authority.
            if (val.length === 0) return strings.explorer.branchNameRequired;
            return null;
          }}
          onSubmit={(name) => {
            const target = createBranchTarget;
            setCreateBranchTarget(null);
            void runAction({
              action: 'create-branch',
              name,
              startPoint: target.startPoint,
            });
          }}
          onCancel={() => setCreateBranchTarget(null)}
        />
      )}
      {mergeIntoTarget !== null && (
        <PromptDialog
          title={strings.explorer.mergeIntoTitle}
          label={strings.explorer.mergeIntoPrompt}
          submitLabel={strings.explorer.mergeIntoSubmit}
          cancelLabel={strings.guard.cancelButton}
          options={mergeIntoTarget.targets}
          initialValue={mergeIntoTarget.targets[0]}
          onSubmit={(target) => {
            const { source } = mergeIntoTarget;
            setMergeIntoTarget(null);
            void runAction({
              action: 'merge-into',
              target,
              source,
            });
          }}
          onCancel={() => setMergeIntoTarget(null)}
        />
      )}
      <ToastRegion />
    </div>
  );
}
