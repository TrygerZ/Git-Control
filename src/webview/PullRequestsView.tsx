/**
 * Sidebar Pull requests view (P07).
 *
 * One column, in the order frame 05 draws it: banners, search row, filter chips,
 * the current-branch card, the grouped list, then the footer. Every decision
 * about *what* to show comes from the pure helpers (`githubGate`, `prFilters`,
 * `listNav`); this file only wires them to the store and the DOM.
 *
 * Two rules held here:
 * - the list is read, never requested directly. Every GitHub read is a store
 *   action, so the load-time stamp the stale rule compares against stays the
 *   single source of truth.
 * - reload happens on mount and on activation of `prs` only while the data is
 *   stale. No polling: this phase has no timer.
 */
import { useEffect, useMemo, useRef, useState, type JSX, type KeyboardEvent } from 'react';
import { loadState, saveState } from './bridge';
import { restoreTarget } from './focusTrap';
import {
  apiQuotaLabel,
  checkLabel,
  checkNamesLabel,
  checkTone,
  compareUrl,
  countdown,
  formatCount,
  pullRequestLabel,
  pullRequestState,
  relativeTime,
  sanitizeGitText,
} from './format';
import { PR_STALE_MS, githubGate, isStale, type GateBanner } from './githubGate';
import { nextIndex } from './listNav';
import {
  PR_PAGE_SIZE,
  badgeCount,
  countByFilter,
  filterPullRequests,
  groupPullRequests,
  matchesText,
  type PrContext,
  type PrFilterId,
} from './prFilters';
import { useGitHubStore, useRepoStore, useRouteStore, useSettingsStore } from './store';
import { useT } from './useT';
import { EmptyState, FileListSkeleton, Icon, InfoBanner } from './ui';
import type { Lang, PullRequestInfo } from '../messages';

const CHIP_ORDER: readonly PrFilterId[] = ['open', 'review-requested', 'mine', 'draft'];

type GroupId = 'needsReview' | 'mine' | 'other';

const GROUP_ORDER: readonly GroupId[] = ['needsReview', 'mine', 'other'];

/** One second is the finest step a quota countdown needs. */
const TICK_MS = 1000;

export function PullRequestsView(): JSX.Element {
  const strings = useT();
  const language = useSettingsStore((s) => s.language);
  const auth = useGitHubStore((s) => s.auth);
  const linkage = useGitHubStore((s) => s.linkage);
  const pullRequests = useGitHubStore((s) => s.pullRequests);
  const closedPullRequests = useGitHubStore((s) => s.closedPullRequests);
  const closedLoaded = useGitHubStore((s) => s.closedLoaded);
  const pullRequestsLoadedAt = useGitHubStore((s) => s.pullRequestsLoadedAt);
  const rateLimit = useGitHubStore((s) => s.rateLimit);
  const loading = useGitHubStore((s) => s.loading);
  const error = useGitHubStore((s) => s.error);
  const loadPullRequests = useGitHubStore((s) => s.loadPullRequests);
  const loadClosedPullRequests = useGitHubStore((s) => s.loadClosedPullRequests);
  const connect = useGitHubStore((s) => s.connect);
  const openUrl = useGitHubStore((s) => s.openUrl);
  const checks = useGitHubStore((s) => s.checks);
  const loadChecks = useGitHubStore((s) => s.loadChecks);
  const status = useRepoStore((s) => s.status);
  const route = useRouteStore((s) => s.route);

  const [query, setQuery] = useState(() => loadState().prQuery);
  const [filter, setFilter] = useState<PrFilterId>(() => loadState().prFilter);
  /** `Recently updated` starts folded: it is the long tail, not the first read. */
  const [expanded, setExpanded] = useState<ReadonlySet<GroupId>>(
    () => new Set<GroupId>(['needsReview', 'mine']),
  );
  const [activeRow, setActiveRow] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const searchRef = useRef<HTMLInputElement>(null);
  const connectRef = useRef<HTMLButtonElement>(null);
  const rowRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const listRef = useRef<HTMLDivElement>(null);

  // A countdown is the only thing here that moves, so the tick exists only while
  // one is on screen. A `setTimeout` re-armed per second, never an interval.
  const needsTick = rateLimit !== null && rateLimit.remaining === 0 && rateLimit.resetAt !== null;
  useEffect(() => {
    if (!needsTick) return undefined;
    const timer = setTimeout(() => setNow(Date.now()), TICK_MS);
    return () => clearTimeout(timer);
  }, [needsTick, now]);

  // Mount and every activation of `prs` reload only when the list is stale. The
  // first load belongs to the sidebar shell, which already asked on mount.
  useEffect(() => {
    if (route.id !== 'prs') return;
    if (isStale(pullRequestsLoadedAt, Date.now(), PR_STALE_MS)) void loadPullRequests();
  }, [route.id, pullRequestsLoadedAt, loadPullRequests]);

  const gate = githubGate({
    view: 'prs',
    auth,
    linkage,
    rateLimit,
    error,
    loading,
    hasData: pullRequests.length > 0,
  });

  const viewerLogin = auth?.login ?? null;
  const ctx: PrContext = { viewerLogin };
  const counts = countByFilter(pullRequests, ctx);

  const visible = useMemo(
    () =>
      filterPullRequests(pullRequests, filter, { viewerLogin }).filter((pr) => matchesText(pr, query)),
    [pullRequests, filter, query, viewerLogin],
  );
  /** Closed rows carry no chip filter: the chips narrow the open list only. */
  const closed = useMemo(
    () => closedPullRequests.filter((pr) => matchesText(pr, query)),
    [closedPullRequests, query],
  );

  const groups = groupPullRequests(visible, ctx);
  const rowsByGroup: Record<GroupId, readonly PullRequestInfo[]> = {
    needsReview: groups.needsReview,
    mine: groups.mine,
    other: [...groups.other, ...closed],
  };
  const flatRows = GROUP_ORDER.flatMap((group) => (expanded.has(group) ? rowsByGroup[group] : []));
  const rowIndex = new Map<number, number>();
  flatRows.forEach((pr, index) => rowIndex.set(pr.number, index));
  const active = Math.min(activeRow, Math.max(0, flatRows.length - 1));

  /**
   * Checks are per row but requested per viewport: one observer, one batch per
   * callback. The store caps the batch at ten and remembers what it already
   * asked, so this file does not slice or dedupe. Rebuilt whenever the visible
   * set changes, because the row buttons are remounted with it.
   */
  // Identity of the visible set. `flatRows` is rebuilt on every render, so it
  // cannot be a dependency without re-creating the observer each time.
  const rowKey = flatRows.map((pr) => `${pr.number}:${pr.headSha ?? ''}`).join(',');
  useEffect(() => {
    // No token means no request: a signed-out user must not reach the API.
    if (auth?.connected !== true) return undefined;
    const rows = rowRefs.current
      .slice(0, flatRows.length)
      .filter((el): el is HTMLButtonElement => el !== null);
    if (rows.length === 0) return undefined;
    // `.gc-prs__groups` is the scroll container; without one the page is the root.
    const root = listRef.current;
    const observer = new IntersectionObserver(
      (entries) => {
        const shas: string[] = [];
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const sha = (entry.target as HTMLElement).dataset.sha;
          if (sha !== undefined && sha.length > 0) shas.push(sha);
        }
        if (shas.length > 0) void loadChecks(shas);
      },
      { root },
    );
    for (const row of rows) observer.observe(row);
    return () => observer.disconnect();
  }, [auth?.connected, rowKey, flatRows.length, loadChecks]);

  const branch = status?.branch ?? null;
  const webUrl = linkage?.webUrl ?? null;
  /** `origin/main` tracks `main`; the card names the branch the compare runs against. */
  const baseBranch = status?.upstream?.replace(/^[^/]*\//, '') ?? null;
  const branchHasPr =
    branch !== null && pullRequests.some((pr) => pr.state === 'open' && pr.headRef === branch);
  const showCard = gate.view === 'ready' && branch !== null && webUrl !== null && !branchHasPr;

  const quota = apiQuotaLabel(rateLimit, language);

  /**
   * A chip counts the page it was given, so a full page means "at least this
   * many". Capping keeps the chip from claiming an exact number it cannot know.
   */
  const chipCount = (count: number): string =>
    badgeCount(count, PR_PAGE_SIZE) ?? formatCount(count, language);

  const setQueryAndPersist = (next: string): void => {
    setQuery(next);
    saveState({ prQuery: next });
  };

  const setFilterAndPersist = (next: PrFilterId): void => {
    setFilter(next);
    saveState({ prFilter: next });
  };

  const clearFilters = (): void => {
    setQueryAndPersist('');
    setFilterAndPersist('open');
    searchRef.current?.focus();
  };

  /**
   * Callback ref for the banner button: `GateBannerView` is a separate component,
   * so it receives a setter rather than the ref object itself.
   */
  const setConnectButton = (element: HTMLButtonElement | null): void => {
    connectRef.current = element;
  };

  /**
   * A cancelled connect resolves normally, so the only signal is whether the
   * button survived the await. Restore focus only when it did.
   */
  const connectAndRestore = async (): Promise<void> => {
    await connect();
    if (restoreTarget(connectRef.current !== null) === 'connect') connectRef.current?.focus();
  };

  const toggleGroup = (group: GroupId): void => {
    const opening = !expanded.has(group);
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(group)) next.delete(group);
      else next.add(group);
      return next;
    });
    // The closed list is fetched once, on the first expand of the long tail.
    if (group === 'other' && opening && !closedLoaded) void loadClosedPullRequests();
  };

  const onRowKey = (event: KeyboardEvent<HTMLButtonElement>, index: number): void => {
    const next = nextIndex(event.key, index, flatRows.length);
    if (next < 0) return;
    event.preventDefault();
    setActiveRow(next);
    rowRefs.current[next]?.focus();
  };

  const chipLabels: Record<PrFilterId, string> = {
    open: strings.prs.chipOpen,
    'review-requested': strings.prs.chipReview,
    mine: strings.prs.chipMine,
    draft: strings.prs.chipDraft,
  };

  const groupTitles: Record<GroupId, string> = {
    needsReview: strings.prs.groupNeedsReview,
    mine: strings.prs.groupMine,
    other: strings.prs.groupRecent,
  };

  return (
    <section className="gc-prs" aria-label={strings.prs.panelAria}>
      {gate.view === 'loading' ? (
        <FileListSkeleton rows={8} />
      ) : gate.view === 'no-remote' ? (
        <EmptyState title={strings.prs.noRemoteTitle} hint={strings.prs.noRemoteBody} />
      ) : gate.view === 'signed-out' ? (
        <EmptyState
          title={strings.prs.signedOutTitle}
          hint={strings.prs.signedOutPrivateBody}
          action={
            <button
              type="button"
              className="gc-button gc-button--action"
              ref={connectRef}
              onClick={() => void connectAndRestore()}
            >
              {strings.prs.signInBannerAction}
            </button>
          }
        />
      ) : (
        <>
          {gate.banner !== null && (
            <GateBannerView
              banner={gate.banner}
              now={now}
              language={language}
              onConnect={connectAndRestore}
              setConnectRef={setConnectButton}
            />
          )}

          <div className="gc-listbar">
            <div className="gc-listbar__controls">
              <div className="gc-listbar__search-wrap">
                <span className="gc-listbar__search-icon" aria-hidden="true">
                  <Icon name="search" />
                </span>
                <input
                  ref={searchRef}
                  type="search"
                  className="gc-listbar__input"
                  value={query}
                  maxLength={100}
                  placeholder={strings.prs.searchPlaceholder}
                  aria-label={strings.prs.searchPlaceholder}
                  onChange={(event) => setQueryAndPersist(event.target.value)}
                />
              </div>
            </div>
          </div>

          <div className="gc-prs__chips" role="group" aria-label={strings.prs.filterState}>
            {CHIP_ORDER.map((id) => {
              const label = chipLabels[id];
              const count = chipCount(counts[id]);
              // The count is in the name, so a screen reader hears what the pill says.
              const name = `${label}, ${count}`;
              return (
                <button
                  key={id}
                  type="button"
                  className="gc-chip gc-prs__chip"
                  aria-pressed={filter === id}
                  aria-label={name}
                  title={name}
                  onClick={() => setFilterAndPersist(id)}
                >
                  <span>{label}</span>
                  <span className="gc-prs__chip-count" aria-hidden="true">
                    {count}
                  </span>
                </button>
              );
            })}
          </div>

          {showCard && branch !== null && webUrl !== null && (
            <div className="gc-prs__card">
              <div className="gc-prs__card-body">
                <code className="gc-prs__card-branch" title={sanitizeGitText(branch)}>
                  {sanitizeGitText(branch)}
                </code>
                {status !== null && status.ahead > 0 && baseBranch !== null && (
                  <span className="gc-prs__card-text">
                    {strings.prs.branchCardAhead(formatCount(status.ahead, language), baseBranch)}
                  </span>
                )}
                <span className="gc-prs__card-text">{strings.prs.branchCardNone}</span>
              </div>
              <button
                type="button"
                className="gc-button gc-button--action"
                onClick={() => void openUrl(compareUrl(webUrl, branch))}
              >
                {strings.prs.createOnGitHub}
              </button>
            </div>
          )}

          {visible.length === 0 && closed.length === 0 ? (
            <EmptyState
              title={strings.prs.emptyTitle}
              hint={strings.prs.emptyBody}
              action={
                <button type="button" className="gc-button gc-button--quiet" onClick={clearFilters}>
                  {strings.prs.clearFilters}
                </button>
              }
            />
          ) : (
            <div className="gc-prs__groups" ref={listRef}>
              {GROUP_ORDER.map((group) => {
                const rows = rowsByGroup[group];
                if (rows.length === 0) return null;
                const title = groupTitles[group];
                const isOpen = expanded.has(group);
                return (
                  <section className="gc-section" key={group} aria-label={title}>
                    <div className="gc-section__head">
                      <h3 className="gc-section__title">
                        <button
                          type="button"
                          className="gc-section__toggle"
                          aria-expanded={isOpen}
                          aria-label={
                            isOpen
                              ? strings.pending.collapseSectionAria(title)
                              : strings.pending.expandSectionAria(title)
                          }
                          onClick={() => toggleGroup(group)}
                        >
                          <span className="gc-section__twisty" aria-hidden="true">
                            <Icon name={isOpen ? 'chevron-down' : 'chevron-right'} />
                          </span>
                          <span className="gc-section__name">{title}</span>
                        </button>
                      </h3>
                      <span className="gc-section__count">{formatCount(rows.length, language)}</span>
                    </div>
                    {isOpen && (
                      <ul className="gc-prs__rows" role="list">
                        {rows.map((pr) => {
                          const index = rowIndex.get(pr.number) ?? 0;
                          const label = pullRequestLabel(pr, language);
                          const title = sanitizeGitText(pr.title);
                          const author = sanitizeGitText(pr.author);
                          const head = sanitizeGitText(pr.headRef);
                          const base = sanitizeGitText(pr.baseRef);
                          // Three states share this slot: `undefined` (never
                          // asked, so render nothing rather than a placeholder
                          // that flashes on every scroll), `null` (asked and
                          // failed), and a summary.
                          const stored = pr.headSha === undefined ? undefined : checks[pr.headSha];
                          const checksFailed = stored === null;
                          const summary = stored ?? undefined;
                          const checkText = checksFailed
                            ? strings.checks.unavailable
                            : summary === undefined
                              ? ''
                              : checkLabel(summary, language);
                          const checkNames =
                            summary === undefined
                              ? ''
                              : checkNamesLabel(summary.failingNames, language);
                          const hiddenFailing =
                            summary === undefined
                              ? 0
                              : summary.failing - summary.failingNames.length;
                          const name = strings.prs.rowAria(label, title, author);
                          // The button's `aria-label` replaces every descendant's
                          // name, so the check state has to travel in it or a
                          // screen reader user never hears it.
                          const rowName = [name, checkText, checkNames]
                            .filter((part) => part.length > 0)
                            .join(', ');
                          return (
                            <li key={pr.number} className="gc-prs__row">
                              <button
                                type="button"
                                className="gc-prs__open"
                                ref={(element) => {
                                  rowRefs.current[index] = element;
                                }}
                                tabIndex={index === active ? 0 : -1}
                                aria-label={rowName}
                                data-sha={pr.headSha ?? ''}
                                onClick={() => void openUrl(pr.url)}
                                onKeyDown={(event) => onRowKey(event, index)}
                              >
                                <span className="gc-prs__state" aria-hidden="true">
                                  <Icon name="pr" />
                                </span>
                                <span className="gc-prs__body">
                                  <span className="gc-prs__title" title={title}>
                                    {title}
                                  </span>
                                  <span className="gc-prs__meta">
                                    <span>#{pr.number}</span>
                                    <span>{pullRequestState(pr.state, language)}</span>
                                    <span>{author}</span>
                                    <span>{relativeTime(pr.updatedAt, now, language)}</span>
                                  </span>
                                  <span className="gc-prs__refs">
                                    {head} → {base}
                                  </span>
                                </span>
                                {/*
                                  Frame 05 puts the count at the row's right edge,
                                  outside the text column so it never squeezes the
                                  title.
                                */}
                                {(summary !== undefined || checksFailed) && (
                                  <span className="gc-prs__check">
                                    {summary === undefined ? (
                                      // Asked and failed: the same shell, so the
                                      // row keeps its height and says why.
                                      <span className="gc-check">{checkText}</span>
                                    ) : (
                                      <>
                                        <span
                                          className={`gc-check gc-check--${checkTone(summary.state)}`}
                                          // Same rule as the inspector: no names, no
                                          // second clause, so no trailing comma.
                                          aria-label={
                                            checkNames.length > 0
                                              ? strings.checks.badgeAria(checkText, checkNames)
                                              : checkText
                                          }
                                        >
                                          <Icon
                                            name={
                                              summary.state === 'failing'
                                                ? 'error'
                                                : summary.state === 'pending'
                                                  ? 'status-running'
                                                  : summary.state === 'passing'
                                                    ? 'check'
                                                    : 'info'
                                            }
                                          />
                                          <span aria-hidden="true">{checkText}</span>
                                          {hiddenFailing > 0 && (
                                            <span className="gc-check__more">
                                              {strings.checks.failingMore(String(hiddenFailing))}
                                            </span>
                                          )}
                                        </span>
                                        {summary.state === 'failing' && checkNames.length > 0 && (
                                          <span className="gc-check__names">{checkNames}</span>
                                        )}
                                      </>
                                    )}
                                  </span>
                                )}
                              </button>
                              {/*
                                The row opens the same URL, so this is the frame's hover
                                affordance: decoration, never a second tab stop.
                              */}
                              <button
                                type="button"
                                className="gc-prs__link"
                                aria-hidden="true"
                                tabIndex={-1}
                                title={strings.prs.openOnGitHub}
                                onClick={() => void openUrl(pr.url)}
                              >
                                <Icon name="external" />
                              </button>
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </section>
                );
              })}
            </div>
          )}
        </>
      )}

      <footer className="gc-prs__footer">
        <span>
          {auth?.connected === true && auth.login !== null
            ? strings.prs.footerConnected(sanitizeGitText(auth.login))
            : strings.prs.footerNotConnected}
        </span>
        {quota !== null && <span className="gc-prs__quota">{quota}</span>}
      </footer>
    </section>
  );
}

/**
 * The one banner the gate selected. Every kind keeps the cached list visible
 * below it; only the Connect button changes what the user can do about it.
 */
function GateBannerView({
  banner,
  now,
  language,
  onConnect,
  setConnectRef,
}: {
  banner: GateBanner;
  now: number;
  language: Lang;
  onConnect(): Promise<void>;
  setConnectRef(element: HTMLButtonElement | null): void;
}): JSX.Element {
  const strings = useT();
  const connectButton = (
    <button
      type="button"
      className="gc-button gc-button--action"
      ref={setConnectRef}
      onClick={() => void onConnect()}
    >
      {strings.prs.signInBannerAction}
    </button>
  );

  switch (banner.kind) {
    case 'sign-in':
      return (
        <InfoBanner tone="info" glyph="info">
          <strong>{strings.prs.signInBannerText}</strong>
          {connectButton}
        </InfoBanner>
      );
    case 'rate-limited':
      return (
        <InfoBanner tone="warning" glyph="warning">
          <strong>{strings.prs.rateLimitedTitle}</strong>
          <span>{strings.prs.rateLimitedBody(countdown(banner.resetAt, now, language))}</span>
          {banner.canConnect && connectButton}
        </InfoBanner>
      );
    case 'offline':
      return (
        <InfoBanner tone="warning" glyph="warning">
          <strong>{strings.format.rateLimit.offline}</strong>
          <span>{strings.format.rateLimit.offlineTitle}</span>
        </InfoBanner>
      );
    case 'invalid-token':
      return (
        <InfoBanner tone="warning" glyph="warning">
          <strong>{strings.format.githubConnection.invalidToken}</strong>
        </InfoBanner>
      );
    case 'scope-warning':
      return (
        <InfoBanner tone="warning" glyph="warning">
          <strong>{strings.github.scopeWarningTitle}</strong>
          <span>{sanitizeGitText(banner.text)}</span>
        </InfoBanner>
      );
    case 'metadata-incomplete':
      return (
        <InfoBanner tone="warning" glyph="warning">
          <strong>{strings.github.metadataIncompleteTitle}</strong>
          <span>{sanitizeGitText(banner.text)}</span>
        </InfoBanner>
      );
  }
}
