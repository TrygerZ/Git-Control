/**
 * Explorer root: the graph plus the inspector, conflict banner, guard dialog,
 * and toast region.
 */
import { useCallback, useEffect, useState, type JSX } from 'react';
import { ConflictPanel, OperationBanner } from './ConflictPanel';
import { GraphCanvas } from './GraphCanvas';
import { GuardDialog } from './GuardDialog';
import { Inspector } from './Inspector';
import { ToastRegion } from './Toast';
import { bridge, loadState } from './bridge';
import { githubBaseUrl, type MenuItem } from './NodeContextMenu';
import {
  useOperationStore,
  useRepoStore,
  useSettingsStore,
  wireHostEvents,
} from './store';
import { ErrorBanner } from './ui';
import type { GraphNode } from '../messages';

export function ExplorerApp(): JSX.Element {
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

  const [githubUrl, setGithubUrl] = useState<string | null>(null);
  const [inspectorOpen, setInspectorOpen] = useState(true);

  useEffect(() => {
    const persisted = loadState();
    if (persisted.selectedHash !== null) selectCommit(persisted.selectedHash);
    const off = wireHostEvents('explorer');
    void loadSettings();
    void refresh();
    // `repos/remotes` is a webview-added request kind; a host that does not
    // implement it yet simply means the GitHub item stays hidden.
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
              pushToast({ level: 'warning', message: 'Tidak bisa menyalin ke clipboard.' }),
            );
          return;
        case 'viewDiff':
          selectCommit(command.hash);
          setInspectorOpen(true);
          return;
        case 'createBranch': {
          const name = window.prompt('Nama branch baru', `fitur/${node.shortHash}`);
          if (name === null || name.trim().length === 0) return;
          void runAction({
            action: 'create-branch',
            name: name.trim(),
            startPoint: command.startPoint,
          });
          return;
        }
        case 'openGitHub':
          // Rendered as an anchor; VS Code handles the navigation itself.
          return;
        default:
      }
    },
    [pushToast, runAction, selectCommit],
  );

  return (
    <div className="gc-explorer">
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
          aria-label="Panel detail"
        >
          <div className="gc-explorer__aside-head">
            <button
              type="button"
              className="gc-button gc-button--quiet"
              aria-expanded={inspectorOpen}
              onClick={() => setInspectorOpen(!inspectorOpen)}
            >
              {inspectorOpen ? 'Sembunyikan detail' : 'Tampilkan detail'}
            </button>
          </div>
          {inspectorOpen && (
            <>
              <Inspector hash={selectedHash} />
              {status !== null && status.conflicts.length > 0 && (
                <ConflictPanel conflicts={status.conflicts} operation={status.operation} />
              )}
              {progressLog.length > 0 && (
                <details className="gc-progress">
                  <summary>Log operasi</summary>
                  <pre className="gc-progress__log">{progressLog.join('\n')}</pre>
                </details>
              )}
            </>
          )}
        </aside>
      </div>

      <GuardDialog />
      <ToastRegion />
    </div>
  );
}
