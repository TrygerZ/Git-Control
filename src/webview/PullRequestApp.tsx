/**
 * Pull request detail panel (P24).
 *
 * One editor tab per pull request, opened from a PR row or the Inspector card.
 * Everything here is read-only: the panel reads the detail, then one tab's data
 * per visit, and every click either opens a diff, reveals a commit, navigates the
 * sidebar, or opens an https URL through the host. The merge box is a disabled
 * placeholder until P25, and it states that in words.
 *
 * Untrusted text is rendered as text nodes only. Bodies keep their line breaks
 * through `white-space: pre-wrap`, never through markup.
 */
import { useEffect, useMemo, useState, type JSX, type ReactNode } from 'react';
import { bridge } from './bridge';
import { formatDuration } from './actionsModel';
import { summarizeChecks } from '../checkSummary';
import {
  authorInitials,
  checkLabel,
  formatCount,
  isSafeImageSrc,
  pullRequestState,
  relativeTime,
  sanitizeGitText,
} from './format';
import type { Catalog } from './i18n';
import {
  diffRequest,
  fileTotals,
  groupChecks,
  statusLines,
  tabCounts,
  type PullTab,
  type StatusTone,
} from './pullView';
import { initialPullTab, usePullStore } from './pullStore';
import { Tablist, type TabDef } from './Tablist';
import { GuardDialog } from './GuardDialog';
import { ToastRegion } from './Toast';
import {
  toErrorBody,
  useGitHubStore,
  useIconThemeStore,
  useOperationStore,
  useRepoStore,
  useSettingsStore,
  wireHostEvents,
} from './store';
import { EmptyState, Icon, InfoBanner, Spinner } from './ui';
import { useT } from './useT';
import { prBranchName } from '../validation';
import type {
  CheckRunInfo,
  CheckSummary,
  Lang,
  OpenDiffPayload,
  PullCommit,
  PullDetail,
  PullFile,
  PullFileStatus,
  TimelineItem,
} from '../messages';

const INT_MAX = 2_147_483_647;

/**
 * The merge box's three options, drawn disabled until P25 wires the mutation.
 * Deliberately not in the catalogs: this build cannot perform any of them, and a
 * translated string would suggest otherwise. P25 adds the keys with the control.
 */
const MERGE_OPTIONS = ['Merge commit', 'Squash and merge', 'Rebase and merge'] as const;

/**
 * `data-pr` is untrusted: it arrives as an attribute, so `Number.parseInt('12x')`
 * would silently open #12. Only a digits-only attribute that passes the same
 * bounds the host validator enforces gets through.
 */
function pullNumberFromBody(): number | null {
  const raw = document.body.dataset.pr;
  if (raw === undefined || !/^\d+$/.test(raw)) return null;
  const value = Number.parseInt(raw, 10);
  return Number.isInteger(value) && value >= 1 && value <= INT_MAX ? value : null;
}

function toneIcon(tone: StatusTone): 'check' | 'status-running' | 'error' | 'info' {
  switch (tone) {
    case 'success':
      return 'check';
    case 'pending':
      return 'status-running';
    case 'failure':
      return 'error';
    case 'neutral':
      return 'info';
  }
}

function reviewWord(state: 'approved' | 'changes_requested' | 'commented', strings: Catalog): string {
  switch (state) {
    case 'approved':
      return strings.prDetail.reviewApproved;
    case 'changes_requested':
      return strings.prDetail.reviewChanges;
    case 'commented':
      return strings.prDetail.reviewCommented;
  }
}

function fileStatusWord(status: PullFileStatus, strings: Catalog): string {
  switch (status) {
    case 'added':
      return strings.prDetail.fileStatusAdded;
    case 'removed':
      return strings.prDetail.fileStatusRemoved;
    case 'renamed':
      return strings.prDetail.fileStatusRenamed;
    case 'modified':
      return strings.prDetail.fileStatusModified;
  }
}

function fileStatusIcon(status: PullFileStatus): 'diff-added' | 'diff-removed' | 'diff-renamed' | 'diff-modified' {
  switch (status) {
    case 'added':
      return 'diff-added';
    case 'removed':
      return 'diff-removed';
    case 'renamed':
      return 'diff-renamed';
    case 'modified':
      return 'diff-modified';
  }
}

function runTone(run: CheckRunInfo): StatusTone {
  if (run.status !== 'completed') return 'pending';
  switch (run.conclusion) {
    case 'failure':
    case 'timed_out':
    case 'action_required':
    case 'cancelled':
      return 'failure';
    default:
      return 'success';
  }
}

interface MergeRow {
  id: string;
  tone: StatusTone;
  title: string;
  /** Second line: the names behind a review verdict, or the merge rule. */
  detail: string | null;
}

/**
 * The merge box's status lines, each stated as a word. Rows with no honest word
 * in this phase's catalog are omitted rather than guessed: the box is disabled,
 * so silence is better than a wrong claim about a dirty branch.
 */
function mergeRows(
  detail: PullDetail,
  checks: CheckSummary | null,
  strings: Catalog,
  language: Lang,
): MergeRow[] {
  const empty: CheckSummary = { state: 'none', total: 0, passed: 0, failing: 0, pending: 0, failingNames: [] };
  const rows: MergeRow[] = [];
  for (const line of statusLines(detail, checks ?? empty)) {
    if (line.id === 'checks') {
      if (checks === null) continue;
      const title =
        checks.state === 'pending'
          ? strings.prDetail.checksRunning
          : checks.state === 'failing'
            ? strings.prDetail.checksFailed(formatCount(checks.failing, language))
            : checks.state === 'passing'
              ? strings.prDetail.allChecksPassed
              : strings.prDetail.checksPassedOf(
                  formatCount(checks.passed, language),
                  formatCount(checks.total, language),
                );
      rows.push({ id: line.id, tone: line.tone, title, detail: null });
    } else if (line.id === 'review') {
      const names =
        detail.changesRequestedBy.length > 0
          ? detail.changesRequestedBy
          : detail.approvedBy.length > 0
            ? detail.approvedBy
            : detail.reviewers;
      if (names.length === 0) continue;
      const title =
        detail.changesRequestedBy.length > 0
          ? strings.prDetail.reviewChanges
          : detail.approvedBy.length > 0
            ? strings.prDetail.reviewApproved
            : strings.prDetail.reviewers;
      rows.push({
        id: line.id,
        tone: line.tone,
        title,
        detail: names.map(sanitizeGitText).join(', '),
      });
    } else if (detail.mergeableState === 'clean') {
      rows.push({
        id: line.id,
        tone: line.tone,
        title: strings.prDetail.noConflicts,
        // The box is a placeholder, so the second line says when merging arrives.
        detail: strings.prDetail.mergeLater,
      });
    }
  }
  return rows;
}

/**
 * The card's edge tone: a failure outranks a pending run, and a neutral row
 * (checks never asked) must not claim green either, so it reads as pending.
 */
function mergeTone(rows: readonly MergeRow[]): 'success' | 'pending' | 'failure' {
  if (rows.some((row) => row.tone === 'failure')) return 'failure';
  if (rows.some((row) => row.tone === 'pending' || row.tone === 'neutral')) return 'pending';
  return 'success';
}

export function PullRequestApp(): JSX.Element {
  const strings = useT();
  const language = useSettingsStore((s) => s.language);
  const loadSettings = useSettingsStore((s) => s.load);
  const loadIconTheme = useIconThemeStore((s) => s.load);
  const linkage = useGitHubStore((s) => s.linkage);
  const pullRequests = useGitHubStore((s) => s.pullRequests);
  const openUrl = useGitHubStore((s) => s.openUrl);
  const connect = useGitHubStore((s) => s.connect);
  const runAction = useOperationStore((s) => s.runAction);
  const busy = useOperationStore((s) => s.state === 'loading');
  const pushToast = useOperationStore((s) => s.pushToast);
  const currentBranch = useRepoStore((s) => s.status?.branch ?? null);

  const detail = usePullStore((s) => s.detail);
  const commits = usePullStore((s) => s.commits);
  const files = usePullStore((s) => s.files);
  const timeline = usePullStore((s) => s.timeline);
  const checks = usePullStore((s) => s.checks);
  const checkRuns = usePullStore((s) => s.checkRuns);
  const tab = usePullStore((s) => s.tab);
  const loading = usePullStore((s) => s.loading);
  const error = usePullStore((s) => s.error);
  const truncated = usePullStore((s) => s.truncated);
  const load = usePullStore((s) => s.load);
  const setTab = usePullStore((s) => s.setTab);
  const loadTab = usePullStore((s) => s.loadTab);

  const number = useMemo(pullNumberFromBody, []);
  const owner = linkage?.available === true ? linkage.owner : null;
  const repo = linkage?.available === true ? linkage.repo : null;
  const now = Date.now();

  useEffect(() => {
    // The tab is the only thing this panel persists, and the panel is rebuilt on
    // every reveal, so it comes back from host state before anything is drawn.
    usePullStore.setState({ tab: initialPullTab() });
    const off = wireHostEvents('pending');
    // The icon-theme pull must follow `wireHostEvents`, like the other roots: the
    // snapshot is requested only once the listener exists.
    void loadIconTheme();
    void loadSettings();
    // The checkout button compares against the current branch, and the fork rule
    // reads the list row; both are cheap and already cached by the sidebar.
    void useRepoStore.getState().loadStatus();
    void useGitHubStore.getState().load();
    return off;
  }, [loadIconTheme, loadSettings]);

  useEffect(() => {
    if (owner === null || repo === null || number === null) return;
    void load({ owner, repo, number });
  }, [owner, repo, number, load]);

  // The status lines and the Checks count need the summary on every tab, so the
  // check read is the one that is not deferred. Commits, files, and the timeline
  // load when their tab is first shown.
  useEffect(() => {
    if (detail === null) return;
    void loadTab('checks');
  }, [detail, loadTab]);

  useEffect(() => {
    if (detail === null) return;
    void loadTab(tab);
  }, [detail, tab, loadTab]);

  const copy = async (text: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text);
      pushToast({ level: 'info', message: strings.inspector.toastHashCopied });
    } catch {
      pushToast({ level: 'warning', message: strings.inspector.toastCopyFailed });
    }
  };

  const revealInGraph = async (hash: string): Promise<void> => {
    try {
      await bridge.request('graph/revealCommit', { hash });
    } catch (err) {
      pushToast({ level: 'warning', message: toErrorBody(err).message });
    }
  };

  const openDiff = async (payload: OpenDiffPayload): Promise<void> => {
    try {
      await bridge.request('actions/openDiff', payload);
    } catch (err) {
      const body = toErrorBody(err);
      pushToast({
        level: body.code === 'UNAVAILABLE' ? 'warning' : 'error',
        message: body.message,
        ...(body.detail === undefined ? {} : { detail: body.detail }),
      });
    }
  };

  const openActions = async (): Promise<void> => {
    try {
      await bridge.request('actions/openSidebarView', { route: { id: 'actions' } });
    } catch (err) {
      pushToast({ level: 'warning', message: toErrorBody(err).message });
    }
  };

  if (number === null) {
    return (
      <div className="gc-prdetail gc-prdetail--empty">
        <EmptyState title={strings.prDetail.loadFailed} />
      </div>
    );
  }

  const retry = (): void => {
    if (owner === null || repo === null) return;
    void load({ owner, repo, number });
  };

  if (linkage === null) {
    return (
      <div className="gc-prdetail gc-prdetail--empty">
        <Spinner label={strings.prDetail.panelTitle(String(number))} />
      </div>
    );
  }

  if (owner === null || repo === null) {
    // No GitHub remote is not a failure: it is a repository this panel cannot
    // describe, and the sentence says so instead of showing a dead error box.
    return (
      <div className="gc-prdetail gc-prdetail--empty">
        <EmptyState title={strings.prDetail.noRemote} />
      </div>
    );
  }

  if (error !== null) {
    const needsSignIn = error.code === 'AUTH_ERROR' || error.code === 'FORBIDDEN';
    return (
      <div className="gc-prdetail gc-prdetail--empty">
        <EmptyState
          title={needsSignIn ? strings.prDetail.signIn : strings.prDetail.loadFailed}
          hint={needsSignIn ? undefined : sanitizeGitText(error.message)}
          action={
            needsSignIn ? (
              <button type="button" className="gc-button gc-button--action" onClick={() => void connect()}>
                {strings.prs.signInBannerAction}
              </button>
            ) : (
              <button type="button" className="gc-button gc-button--quiet" onClick={retry}>
                {strings.prDetail.retry}
              </button>
            )
          }
        />
      </div>
    );
  }

  if (detail === null) {
    return (
      <div className="gc-prdetail gc-prdetail--empty">
        {loading ? (
          <Spinner label={strings.prDetail.panelTitle(String(number))} />
        ) : (
          <EmptyState title={strings.prDetail.loadFailed} />
        )}
      </div>
    );
  }

  const checkoutRef =
    Number.isInteger(detail.number) && detail.number >= 1 && detail.number <= INT_MAX
      ? prBranchName(detail.number)
      : null;
  const alreadyCheckedOut = checkoutRef !== null && currentBranch === checkoutRef;
  const listed = pullRequests.find((pr) => pr.number === detail.number);
  const isFork = listed?.isFork === true;
  const counts = tabCounts(detail, checks);
  const withCount = (label: string, count: number | null): string =>
    count === null ? label : `${label}, ${formatCount(count, language)}`;
  // One panel is mounted at a time, so every tab points at the same region and
  // no `aria-controls` ever names an element that is not there.
  const panelId = 'gc-prtabs-panel';
  const tabs: TabDef[] = [
    {
      id: 'conversation',
      label: strings.prDetail.tabConversation,
      ariaLabel: withCount(strings.prDetail.tabConversation, counts.conversation),
      count: counts.conversation === null ? null : formatCount(counts.conversation, language),
      panelId,
    },
    {
      id: 'commits',
      label: strings.prDetail.tabCommits,
      ariaLabel: withCount(strings.prDetail.tabCommits, counts.commits),
      count: counts.commits === null ? null : formatCount(counts.commits, language),
      panelId,
    },
    {
      id: 'checks',
      label: strings.prDetail.tabChecks,
      ariaLabel: withCount(strings.prDetail.tabChecks, counts.checks),
      count: counts.checks === null ? null : formatCount(counts.checks, language),
      panelId,
    },
    {
      id: 'files',
      label: strings.prDetail.tabFiles,
      ariaLabel: withCount(strings.prDetail.tabFiles, counts.files),
      count: counts.files === null ? null : formatCount(counts.files, language),
      panelId,
    },
  ];
  const avatar = detail.authorAvatarUrl;

  return (
    <div className="gc-prdetail">
      <header className="gc-prdetail__header">
        <div className="gc-prdetail__bar">
          <h1 className="gc-prdetail__title">
            {sanitizeGitText(detail.title)}{' '}
            <span className="gc-prdetail__number">#{detail.number}</span>
          </h1>
          <div className="gc-prdetail__actions">
            <button
              type="button"
              className="gc-button gc-button--action"
              disabled={alreadyCheckedOut || busy}
              title={
                alreadyCheckedOut
                  ? strings.prs.checkedOut
                  : busy
                    ? strings.explorerSync.fetchDisabledBusy
                    : undefined
              }
              onClick={() => {
                void runAction({
                  action: 'checkout-pr',
                  number: detail.number,
                  ...(isFork ? { readOnly: true } : {}),
                });
              }}
            >
              <Icon name="git-branch" />
              {strings.prDetail.checkoutBranch}
            </button>
            {/*
              Frame 06 has three buttons; review submission is P25, so this one is
              a placeholder. No catalog key added (section 7 fixes the key set), and
              no handler: the `title` says why it is inert.
            */}
            <button
              type="button"
              className="gc-button gc-button--quiet"
              disabled
              aria-label={strings.prDetail.mergeDisabledAria}
              title={strings.prDetail.mergeDisabledAria}
            >
              <Icon name="check" />
              Review changes
            </button>
            <button
              type="button"
              className="gc-button gc-button--quiet"
              disabled={detail.htmlUrl.length === 0}
              onClick={() => void openUrl(detail.htmlUrl)}
            >
              <Icon name="external" />
              {strings.prDetail.openOnGitHub}
            </button>
            <button
              type="button"
              className="gc-icon-button"
              disabled
              aria-label={strings.prDetail.tooltipMoreUnavailable}
              title={strings.prDetail.tooltipMoreUnavailable}
            >
              <Icon name="ellipsis" />
            </button>
          </div>
        </div>
        <div className="gc-prdetail__branchline">
          <span className={`gc-prdetail__state gc-prdetail__state--${detail.state}`}>
            {pullRequestState(detail.state, language)}
          </span>
          <span className="gc-avatar" aria-hidden="true">
            {avatar !== null && isSafeImageSrc(avatar) ? (
              <img className="gc-avatar__img" src={avatar} alt="" />
            ) : (
              authorInitials(detail.author)
            )}
          </span>
          <span className="gc-prdetail__sentence">
            {strings.prDetail.wantsToMerge(
              sanitizeGitText(detail.author),
              formatCount(detail.commits, language),
              sanitizeGitText(detail.baseRef),
              sanitizeGitText(detail.headRef),
            )}
          </span>
          <span className="gc-chip gc-prdetail__chip" title={sanitizeGitText(detail.baseRef)}>
            {sanitizeGitText(detail.baseRef)}
          </span>
          <span className="gc-chip gc-prdetail__chip" title={sanitizeGitText(detail.headRef)}>
            {sanitizeGitText(detail.headRef)}
          </span>
          {isFork && <span className="gc-chip gc-prdetail__chip">{strings.prs.readOnlyChip}</span>}
        </div>
      </header>

      {/* The strip holds the tablist and the diffstat under one hairline (frame 06). */}
      <div className="gc-prtabs">
        <Tablist
          tabs={tabs}
          activeId={tab}
          onSelect={(id) => setTab(id as PullTab)}
          ariaLabel={strings.prDetail.panelTitle(String(detail.number))}
          idPrefix="gc-prtabs"
          classPrefix="gc-prtabs"
        />
        <span className="gc-prtabs__stat">
          <span className="gc-prtabs__add">+{formatCount(detail.additions, language)}</span>
          <span className="gc-prtabs__del">-{formatCount(detail.deletions, language)}</span>
        </span>
      </div>

      <div className="gc-prdetail__body">
        <section
          id={panelId}
          className="gc-prdetail__main"
          role="tabpanel"
          aria-labelledby={`gc-prtabs-tab-${tab}`}
        >
          {tab === 'conversation' && (
            <ConversationTab
              detail={detail}
              timeline={timeline}
              checks={checks}
              truncated={truncated.timeline}
              now={now}
              strings={strings}
              language={language}
            />
          )}
          {tab === 'commits' && (
            <CommitsTab
              commits={commits}
              truncated={truncated.commits}
              now={now}
              strings={strings}
              language={language}
              onCopy={(hash) => void copy(hash)}
              onReveal={(hash) => void revealInGraph(hash)}
            />
          )}
          {tab === 'checks' && (
            <ChecksTab
              summary={checks}
              runs={checkRuns}
              strings={strings}
              language={language}
              onOpen={(url) => void openUrl(url)}
              onOpenActions={() => void openActions()}
            />
          )}
          {tab === 'files' && (
            <FilesTab
              detail={detail}
              files={files}
              truncated={truncated.files}
              strings={strings}
              language={language}
              onOpenDiff={(payload) => void openDiff(payload)}
            />
          )}
        </section>

        <aside className="gc-prrail">
          <section className="gc-prrail__section">
            <h2 className="gc-prrail__title">{strings.prDetail.reviewers}</h2>
            <ul className="gc-prrail__list">
              {detail.reviewers.map((reviewer) => (
                <li key={reviewer}>{sanitizeGitText(reviewer)}</li>
              ))}
            </ul>
          </section>
          <section className="gc-prrail__section">
            <h2 className="gc-prrail__title">{strings.prDetail.labels}</h2>
            <div className="gc-prrail__labels">
              {detail.labels.map((label) => (
                <span key={label.name} className="gc-chip">
                  {sanitizeGitText(label.name)}
                </span>
              ))}
            </div>
          </section>
        </aside>
      </div>

      <GuardDialog />
      <ToastRegion />
    </div>
  );
}

// ------------------------------------------------------------------ tabs

function ConversationTab({
  detail,
  timeline,
  checks,
  truncated,
  now,
  strings,
  language,
}: {
  detail: PullDetail;
  timeline: TimelineItem[] | null;
  checks: CheckSummary | null;
  truncated: boolean;
  now: number;
  strings: Catalog;
  language: Lang;
}): JSX.Element {
  const rows = mergeRows(detail, checks, strings, language);
  const tone = mergeTone(rows);
  return (
    <>
      {detail.body.trim().length > 0 && (
        <article className="gc-prdetail__card" aria-label={strings.prDetail.tabConversation}>
          <div className="gc-prdetail__meta">
            <span className="gc-avatar" aria-hidden="true">
              {authorInitials(detail.author)}
            </span>
            <strong>{sanitizeGitText(detail.author)}</strong>
            <span>{relativeTime(detail.createdAt, now, language)}</span>
          </div>
          <p className="gc-prdetail__text">{sanitizeGitText(detail.body)}</p>
        </article>
      )}

      {timeline !== null && timeline.length > 0 && (
        <ol className="gc-prdetail__timeline">
          {timeline.map((item) => (
            <li key={`${item.kind}-${item.id}`} className="gc-prdetail__event">
              <div className="gc-prdetail__meta">
                <strong>{sanitizeGitText(item.author)}</strong>
                <span>{relativeTime(item.at, now, language)}</span>
                {item.kind === 'review' && <span className="gc-chip">{reviewWord(item.state, strings)}</span>}
                {item.kind === 'reviewComment' && (
                  <span className="gc-chip" title={sanitizeGitText(item.path)}>
                    {sanitizeGitText(item.path)}
                  </span>
                )}
              </div>
              <p className="gc-prdetail__text">{sanitizeGitText(item.body)}</p>
            </li>
          ))}
        </ol>
      )}

      {timeline !== null && truncated && (
        <InfoBanner tone="info" glyph="info">
          {strings.prDetail.truncatedNote(formatCount(timeline.length, language))}
        </InfoBanner>
      )}

      {/*
        Disabled by construction: there is no click handler in this box and no
        merge request kind in this build. P25 replaces it with the real control.
      */}
      <section
        className={
          tone === 'success'
            ? 'gc-prdetail__merge'
            : `gc-prdetail__merge gc-prdetail__merge--${tone}`
        }
        aria-label={strings.prDetail.mergeDisabledAria}
      >
        <ul className="gc-prdetail__statuses">
          {rows.map((row) => (
            <li
              key={row.id}
              className={`gc-prdetail__status gc-prdetail__status--${row.tone}`}
            >
              <Icon name={toneIcon(row.tone)} />
              <span className="gc-prdetail__status-body">
                <strong className="gc-prdetail__status-title">{sanitizeGitText(row.title)}</strong>
                {row.detail !== null && (
                  <span className="gc-prdetail__status-detail">{sanitizeGitText(row.detail)}</span>
                )}
              </span>
            </li>
          ))}
        </ul>
        <div
          className="gc-segmented gc-prdetail__merge-options"
          role="group"
          aria-label={strings.prDetail.mergeDisabledAria}
          aria-disabled="true"
        >
          {MERGE_OPTIONS.map((option) => (
            <button key={option} type="button" className="gc-button" aria-disabled="true" disabled>
              {option}
            </button>
          ))}
        </div>
        <p className="gc-prdetail__merge-caption">{strings.prDetail.mergeLater}</p>
      </section>
    </>
  );
}

function CommitsTab({
  commits,
  truncated,
  now,
  strings,
  language,
  onCopy,
  onReveal,
}: {
  commits: PullCommit[] | null;
  truncated: boolean;
  now: number;
  strings: Catalog;
  language: Lang;
  onCopy(hash: string): void;
  onReveal(hash: string): void;
}): JSX.Element {
  if (commits === null) {
    return <Spinner label={strings.prDetail.tabCommits} />;
  }
  return (
    <>
      <ul className="gc-prcommit__list">
        {commits.map((commit) => (
          <li key={commit.hash} className="gc-prcommit">
            {/*
              The row is the tab stop for "show in graph"; copy and the explicit
              graph button are siblings, never nested buttons.
            */}
            <button
              type="button"
              className="gc-prcommit__open"
              onClick={() => onReveal(commit.hash)}
            >
              <Icon name="commit" />
              <span className="gc-prcommit__body">
                <span className="gc-prcommit__subject">{sanitizeGitText(commit.subject)}</span>
                <span className="gc-prcommit__meta">
                  <span>{sanitizeGitText(commit.author)}</span>
                  <span>{relativeTime(commit.committedAt, now, language)}</span>
                  <span className="gc-prcommit__hash">{commit.shortHash}</span>
                </span>
              </span>
            </button>
            <button
              type="button"
              className="gc-icon-button"
              aria-label={strings.prDetail.copyHash}
              title={strings.prDetail.copyHash}
              onClick={() => onCopy(commit.hash)}
            >
              <Icon name="copy" />
            </button>
            <button
              type="button"
              className="gc-icon-button"
              aria-label={strings.prDetail.openCommitInGraph}
              title={strings.prDetail.openCommitInGraph}
              onClick={() => onReveal(commit.hash)}
            >
              <Icon name="graph" />
            </button>
          </li>
        ))}
      </ul>
      {truncated && (
        <InfoBanner tone="info" glyph="info">
          {strings.prDetail.truncatedNote(formatCount(commits.length, language))}
        </InfoBanner>
      )}
    </>
  );
}

function ChecksTab({
  summary,
  runs,
  strings,
  language,
  onOpen,
  onOpenActions,
}: {
  summary: CheckSummary | null;
  runs: CheckRunInfo[] | null;
  strings: Catalog;
  language: Lang;
  onOpen(url: string): void;
  onOpenActions(): void;
}): JSX.Element {
  if (runs === null || summary === null) {
    return <Spinner label={strings.prDetail.tabChecks} />;
  }
  const groups = groupChecks(runs);
  return (
    <>
      <p className="gc-prcheck__summary">{checkLabel(summary, language)}</p>
      {groups.map((group) => (
        <section key={group.app} className="gc-prcheck__group">
          <h3 className="gc-prcheck__app">{sanitizeGitText(group.app)}</h3>
          <ul className="gc-prcheck__runs">
            {group.runs.map((run) => (
              <li key={run.id}>
                <RunRow run={run} strings={strings} language={language} onOpen={onOpen} />
              </li>
            ))}
          </ul>
        </section>
      ))}
      <div className="gc-prcheck__footer">
        <button type="button" className="gc-button gc-button--quiet" onClick={onOpenActions}>
          {strings.prDetail.openInActions}
        </button>
      </div>
    </>
  );
}

function RunRow({
  run,
  strings,
  language,
  onOpen,
}: {
  run: CheckRunInfo;
  strings: Catalog;
  language: Lang;
  onOpen(url: string): void;
}): JSX.Element {
  const tone = runTone(run);
  const duration =
    run.startedAt !== null && run.completedAt !== null
      ? formatDuration(run.startedAt, Date.parse(run.completedAt), false, language)
      : '';
  // One run's summary is the cheapest honest state word: it reuses the badge
  // copy ("1/1 checks passed", "1 failing") instead of inventing a fourth table.
  const stateText = checkLabel(summarizeChecks([run]), language);
  const body: ReactNode = (
    <>
      <Icon name={toneIcon(tone)} />
      <span className="gc-prcheck__name">{sanitizeGitText(run.name)}</span>
      <span className="gc-prcheck__meta">
        <span>{stateText}</span>
        {duration.length > 0 && <span>{duration}</span>}
      </span>
    </>
  );
  if (run.url.length === 0) {
    return <div className="gc-prcheck__run">{body}</div>;
  }
  return (
    <button
      type="button"
      className="gc-prcheck__run"
      onClick={() => onOpen(run.url)}
      aria-label={`${sanitizeGitText(run.name)}, ${stateText}`}
    >
      {body}
    </button>
  );
}

function FilesTab({
  detail,
  files,
  truncated,
  strings,
  language,
  onOpenDiff,
}: {
  detail: PullDetail;
  files: { files: PullFile[]; mergeBase: string | null } | null;
  truncated: boolean;
  strings: Catalog;
  language: Lang;
  onOpenDiff(payload: OpenDiffPayload): void;
}): JSX.Element {
  if (files === null) {
    return <Spinner label={strings.prDetail.tabFiles} />;
  }
  const totals = fileTotals(files.files);
  return (
    <>
      <p className="gc-prfile__summary">
        {strings.prDetail.filesSummary(
          formatCount(totals.files, language),
          formatCount(totals.additions, language),
          formatCount(totals.deletions, language),
        )}
      </p>
      <ul className="gc-prfile__list">
        {files.files.map((file) => {
          const request = diffRequest(file, detail, files.mergeBase);
          const content = (
            <>
              <Icon name={fileStatusIcon(file.status)} />
              <span className="gc-prfile__path" title={sanitizeGitText(file.path)}>
                {sanitizeGitText(file.path)}
              </span>
              <span className="gc-prfile__status">{fileStatusWord(file.status, strings)}</span>
              <span className="gc-prfile__churn">
                <span className="gc-prfile__add">+{formatCount(file.additions, language)}</span>{' '}
                <span className="gc-prfile__del">-{formatCount(file.deletions, language)}</span>
              </span>
            </>
          );
          return (
            <li key={file.path} className="gc-prfile">
              {request === null ? (
                // The merge base needs both commits locally; without it the row
                // states why and sends nothing, rather than opening a wrong diff.
                <div className="gc-prfile__row gc-prfile__row--static">
                  {content}
                  <span className="gc-prfile__hint">{strings.prDetail.fetchBranchFirst}</span>
                </div>
              ) : (
                <button
                  type="button"
                  className="gc-prfile__row"
                  aria-label={strings.prDetail.openDiffAria(sanitizeGitText(file.path))}
                  onClick={() => onOpenDiff(request)}
                >
                  {content}
                </button>
              )}
            </li>
          );
        })}
      </ul>
      {truncated && (
        <InfoBanner tone="info" glyph="info">
          {strings.prDetail.truncatedNote(formatCount(files.files.length, language))}
        </InfoBanner>
      )}
    </>
  );
}
