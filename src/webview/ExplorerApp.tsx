/**
 * Explorer root: the graph plus the inspector, conflict banner, guard dialog,
 * and toast region.
 */
import { useCallback, useEffect, useId, useRef, useState, type JSX } from 'react';
import { ConflictPanel, OperationBanner } from './ConflictPanel';
import { GraphCanvas } from './GraphCanvas';
import { GuardDialog } from './GuardDialog';
import { Inspector } from './Inspector';
import { Contributors } from './Contributors';
import { ExplorerHeaderActions } from './ExplorerHeaderActions';
import { ExplorerSyncActions } from './ExplorerSyncActions';
import { MergeDialog, mergeActionPayload, mergeIntoActionPayload } from './MergeDialog';
import { PromptDialog } from './PromptDialog';
import { ToastRegion } from './Toast';
import { bridge, loadState } from './bridge';
import { githubBaseUrl, NodeContextMenu, type MenuAnchor, type MenuItem } from './NodeContextMenu';
import { useT } from './useT';
import {
  useGitHubStore,
  useIconThemeStore,
  useOperationStore,
  useRepoStore,
  useSettingsStore,
  wireHostEvents,
} from './store';
import { ContextBar, ErrorBanner, Icon } from './ui';
import { sanitizeGitText } from './format';
import type { CommitDetail, GraphNode } from '../messages';

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
  const loadIconTheme = useIconThemeStore((s) => s.load);
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
  const [mergeTarget, setMergeTarget] = useState<{
    branch: string;
  } | null>(null);

  const [githubUrl, setGithubUrl] = useState<string | null>(null);
  const [inspectorOpen, setInspectorOpen] = useState(true);
  /** The commit the Inspector loaded, so the aside footer can act on it. */
  const [selectedDetail, setSelectedDetail] = useState<CommitDetail | null>(null);
  const [menuAnchor, setMenuAnchor] = useState<MenuAnchor | null>(null);
  const moreRef = useRef<HTMLButtonElement>(null);
  const openUrl = useGitHubStore((s) => s.openUrl);
  // `aria-controls` needs a stable id even across two roots in one bundle.
  const asideId = useId();

  useEffect(() => {
    const persisted = loadState();
    if (persisted.selectedHash !== null) selectCommit(persisted.selectedHash);
    const off = wireHostEvents('explorer');
    // Icon theme pull must follow `wireHostEvents`: the race is closed by the
    // webview asking for the snapshot after its listeners exist.
    void loadIconTheme();
    void loadSettings();
    void refresh();
    // The host parses each remote URL, so the GitHub item appears only when a
    // GitHub remote actually exists.
    bridge
      .request('repos/remotes', {})
      .then((result) => setGithubUrl(githubBaseUrl(result.remotes)))
      .catch(() => setGithubUrl(null));
    // Commit avatars, the remote linkage, and the context-menu item all read this
    // slice, so the load stays even though the panel that used to own it is gone.
    void useGitHubStore.getState().load();
    return off;
  }, [loadIconTheme, loadSettings, refresh, selectCommit]);

  const onMenuCommand = useCallback(
    (item: MenuItem, node: GraphNode): void => {
      const command = item.command;
      switch (command.kind) {
        case 'action':
          if (command.request.action === 'merge') {
            setMergeTarget({ branch: command.request.branch });
            return;
          }
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

  /*
   * The aside footer's rules, taken from the same two facts the canvas menu reads:
   * the commit at HEAD cannot be checked out again, and an operation in flight
   * would collide with the next one.
   */
  const atHead = selectedDetail !== null && selectedDetail.hash === status?.head;
  const busy = status !== null && status.operation !== 'idle';
  /*
   * The node the menu acts on, from the loaded graph when it is there.
   *
   * `menuItemsFor` gates `push-up-to` on `node.local`, so a synthesised node that
   * claimed to be local would offer a push for a commit already on the remote. The
   * fallback says not-local: an unanswerable question is not a reason to offer it.
   */
  const graphNode = selectedDetail === null
    ? undefined
    : graph?.nodes.find((n) => n.hash === selectedDetail.hash);
  const menuNode: GraphNode | null =
    graphNode ??
    (selectedDetail === null
      ? null
      : {
          hash: selectedDetail.hash,
          shortHash: selectedDetail.shortHash,
          x: 0,
          y: 0,
          lane: 0,
          isHead: atHead,
          isMerge: selectedDetail.parents.length > 1,
          local: false,
          subject: selectedDetail.subject,
          authorName: selectedDetail.authorName,
          authoredAt: selectedDetail.authoredAt,
          refNames: selectedDetail.refNames,
        });

  return (
    <div className="gc-explorer">
      {/*
        Help and More live beside the crumbs, not inside them: `ContextBar` returns
        null until the first status arrives, and both buttons must survive that.
      */}
      <div className="gc-explorer__top">
        <ContextBar status={status} subject={newestSubject} />
        <ExplorerSyncActions />
        <ExplorerHeaderActions />
      </div>

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
                <Inspector hash={selectedHash} onDetailLoaded={setSelectedDetail} />
                <Contributors />
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

          {/*
            Frame 01 (`9:179`): the aside's fixed footer. It is a sibling of the
            scrollable body, not a child, so Checkout stays on screen however long
            the file list gets. Availability matches the canvas menu's rules, so
            the two surfaces cannot disagree.
          */}
          {inspectorOpen && selectedDetail !== null && (
            <div className="gc-explorer__aside-actions gc-inspector__actions">
              <button
                type="button"
                className="gc-button gc-button--quiet"
                disabled={atHead || busy}
                title={
                  atHead
                    ? strings.inspector.actionCheckoutAtHead
                    : busy
                      ? strings.inspector.actionBusy
                      : strings.inspector.actionCheckoutTitle
                }
                onClick={() =>
                  void runAction({ action: 'checkout-commit', hash: selectedDetail.hash })
                }
              >
                <Icon name="check" />
                <span>{strings.inspector.actionCheckout}</span>
              </button>
              <button
                type="button"
                className="gc-button gc-button--quiet"
                disabled={busy}
                title={busy ? strings.inspector.actionBusy : strings.inspector.actionBranchHereTitle}
                onClick={() =>
                  setCreateBranchTarget({
                    startPoint: selectedDetail.hash,
                    defaultName: `${strings.explorer.defaultBranchPrefix}/${selectedDetail.shortHash}`,
                  })
                }
              >
                <Icon name="branch-add" />
                <span>{strings.inspector.actionBranchHere}</span>
              </button>
              <button
                ref={moreRef}
                type="button"
                className="gc-icon-button gc-inspector__more"
                aria-label={strings.inspector.actionMoreAria}
                title={strings.inspector.actionMoreAria}
                aria-haspopup="menu"
                aria-expanded={menuAnchor !== null}
                onClick={() => {
                  const box = moreRef.current?.getBoundingClientRect();
                  setMenuAnchor(box === undefined ? { x: 0, y: 0 } : { x: box.left, y: box.bottom });
                }}
              >
                <Icon name="ellipsis" />
              </button>
            </div>
          )}

          {/*
            The canvas menu, not a copy of it: one implementation owns the
            destructive verbs. The node comes from the loaded graph when it is
            there; `menuItemsFor` gates `push-up-to` on `node.local`, so the
            fallback says not-local rather than offering a push for a commit that
            may already be on the remote.
          */}
          {menuAnchor !== null && menuNode !== null && (
            <NodeContextMenu
              node={menuNode}
              status={status}
              refs={graph?.refs ?? []}
              githubUrl={githubUrl}
              anchor={menuAnchor}
              onSelect={(item) => onMenuCommand(item, menuNode)}
              onClose={() => setMenuAnchor(null)}
            />
          )}
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
          checkboxLabel={strings.mergeDialog.noFfLabel}
          checkboxHint={strings.mergeDialog.noFfHint}
          onSubmit={(target, noFf) => {
            const { source } = mergeIntoTarget;
            setMergeIntoTarget(null);
            void runAction(mergeIntoActionPayload(target, source, !!noFf));
          }}
          onCancel={() => setMergeIntoTarget(null)}
        />
      )}
      {mergeTarget !== null && (
        <MergeDialog
          branch={mergeTarget.branch}
          currentBranch={status?.branch ?? null}
          onSubmit={(noFf) => {
            const { branch } = mergeTarget;
            setMergeTarget(null);
            void runAction(mergeActionPayload(branch, noFf));
          }}
          onCancel={() => setMergeTarget(null)}
        />
      )}
      <ToastRegion />
    </div>
  );
}
