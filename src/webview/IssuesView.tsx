/**
 * Sidebar Issues view (P08).
 *
 * One column, matching frame 09: banners, search row with label filter, filter
 * chips (Assigned, Created, Mentioned), grouped issue list with expandable row
 * preview, and footer. Every decision routes through pure helpers (`githubGate`,
 * `issueFilters`, `issueText`, `listNav`).
 */
import { useEffect, useMemo, useRef, useState, type JSX, type KeyboardEvent } from 'react';
import { loadState, saveState } from './bridge';
import { restoreTarget } from './focusTrap';
import {
  apiQuotaLabel,
  countdown,
  formatCount,
  relativeTime,
  sanitizeGitText,
} from './format';
import { githubGate, isStale, type GateBanner } from './githubGate';
import { filterIssues, labelOptions, matchesText } from './issueFilters';
import { issueExcerpt } from './issueText';
import { nextIndex } from './listNav';
import { useGitHubStore, useIssuesStore, useRouteStore, useSettingsStore } from './store';
import { useT } from './useT';
import { EmptyState, FileListSkeleton, Icon, InfoBanner } from './ui';
import type { IssueInfo, IssueListFilter, IssueStateFilter, Lang } from '../messages';

const CHIP_ORDER: readonly IssueListFilter[] = ['assigned', 'created', 'mentioned'];

type GroupId = 'active' | 'closed';

const GROUP_ORDER: readonly GroupId[] = ['active', 'closed'];

/** One second is the finest step a quota countdown needs. */
const TICK_MS = 1000;

export function IssuesView(): JSX.Element {
  const strings = useT();
  const language = useSettingsStore((s) => s.language);
  const auth = useGitHubStore((s) => s.auth);
  const linkage = useGitHubStore((s) => s.linkage);
  const rateLimit = useGitHubStore((s) => s.rateLimit);
  const ghLoading = useGitHubStore((s) => s.loading);
  const ghError = useGitHubStore((s) => s.error);
  const connect = useGitHubStore((s) => s.connect);
  const openUrl = useGitHubStore((s) => s.openUrl);

  const issues = useIssuesStore((s) => s.issues);
  const issuesByFilter = useIssuesStore((s) => s.issuesByFilter);
  const loadedAt = useIssuesStore((s) => s.loadedAt);
  const filter = useIssuesStore((s) => s.filter);
  const state = useIssuesStore((s) => s.state);
  const select = useIssuesStore((s) => s.select);
  const issuesLoading = useIssuesStore((s) => s.loading);
  const issuesError = useIssuesStore((s) => s.error);
  const load = useIssuesStore((s) => s.load);

  const route = useRouteStore((s) => s.route);

  const [query, setQuery] = useState(() => loadState().issueQuery);
  const [labelFilter, setLabelFilter] = useState<string | null>(() => loadState().issueLabel);
  const [menuOpen, setMenuOpen] = useState(false);
  const [expandedGroups, setExpandedGroups] = useState<ReadonlySet<GroupId>>(
    () => new Set<GroupId>(['active']),
  );
  const [expandedIssues, setExpandedIssues] = useState<ReadonlySet<number>>(
    () => new Set<number>(),
  );
  const [activeRow, setActiveRow] = useState(0);
  const [now, setNow] = useState(() => Date.now());

  const searchRef = useRef<HTMLInputElement>(null);
  const connectRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const filterButtonRef = useRef<HTMLButtonElement>(null);
  const rowRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const needsTick = rateLimit !== null && rateLimit.remaining === 0 && rateLimit.resetAt !== null;
  useEffect(() => {
    if (!needsTick) return undefined;
    const timer = setTimeout(() => setNow(Date.now()), TICK_MS);
    return () => clearTimeout(timer);
  }, [needsTick, now]);

  useEffect(() => {
    if (
      route.id === 'issues' &&
      auth?.connected === true &&
      isStale(loadedAt[filter][state], Date.now(), 60_000)
    ) {
      void load(filter, state);
    }
  }, [route.id, auth?.connected, filter, state, loadedAt, load]);

  useEffect(() => {
    if (!menuOpen) return undefined;
    // A keyboard user lands on the first item; the menu is not in the tab ring.
    menuRef.current?.querySelector<HTMLElement>('[role^="menuitem"]')?.focus();
    const onClickOutside = (e: MouseEvent): void => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    window.addEventListener('mousedown', onClickOutside);
    return () => window.removeEventListener('mousedown', onClickOutside);
  }, [menuOpen]);

  const loading = ghLoading || issuesLoading;
  const error = issuesError ?? ghError;
  const gate = githubGate({
    view: 'issues',
    auth,
    linkage,
    rateLimit,
    error,
    loading,
    hasData: issues.length > 0,
  });

  const labels = useMemo(() => labelOptions(issues), [issues]);

  const visible = useMemo(
    () => filterIssues(issues, { label: labelFilter, query }),
    [issues, labelFilter, query],
  );

  // Recently closed is a preview under the open list; the Closed state shows one group.
  const closedVisible = useMemo(
    () =>
      state === 'open'
        ? issuesByFilter[filter].closed.filter(
            (issue) =>
              (labelFilter === null || issue.labels.some((l) => l.name === labelFilter)) &&
              matchesText(issue, query),
          )
        : [],
    [state, issuesByFilter, filter, labelFilter, query],
  );

  const groups: readonly GroupId[] = state === 'closed' ? ['active'] : GROUP_ORDER;

  const rowsByGroup: Record<GroupId, readonly IssueInfo[]> = {
    active: visible,
    closed: closedVisible,
  };

  const flatRows = groups.flatMap((group) => (expandedGroups.has(group) ? rowsByGroup[group] : []));
  const rowIndex = new Map<number, number>();
  flatRows.forEach((issue, index) => rowIndex.set(issue.number, index));
  const active = Math.min(activeRow, Math.max(0, flatRows.length - 1));

  const quota = apiQuotaLabel(rateLimit, language);

  const setQueryAndPersist = (next: string): void => {
    setQuery(next);
    saveState({ issueQuery: next });
  };

  const setLabelFilterAndPersist = (next: string | null): void => {
    setLabelFilter(next);
    saveState({ issueLabel: next });
  };

  const selectAndPersist = (
    nextFilter: IssueListFilter,
    nextState: IssueStateFilter = state,
  ): void => {
    select(nextFilter, nextState);
    saveState({ issueFilter: nextFilter });
    void load(nextFilter, nextState);
  };

  const clearFilters = (): void => {
    select('assigned', 'open');
    saveState({ issueFilter: 'assigned', issueQuery: '', issueLabel: null });
    void load('assigned', 'open');
    setQuery('');
    setLabelFilter(null);
    searchRef.current?.focus();
  };

  const setConnectButton = (element: HTMLButtonElement | null): void => {
    connectRef.current = element;
  };

  const connectAndRestore = async (): Promise<void> => {
    await connect();
    if (restoreTarget(connectRef.current !== null) === 'connect') connectRef.current?.focus();
  };

  const toggleGroup = (group: GroupId): void => {
    const opening = !expandedGroups.has(group);
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(group)) next.delete(group);
      else next.add(group);
      return next;
    });
    if (group === 'closed' && opening && loadedAt[filter].closed === null) {
      void load(filter, 'closed');
    }
  };

  const toggleIssue = (num: number): void => {
    setExpandedIssues((prev) => {
      const next = new Set(prev);
      if (next.has(num)) next.delete(num);
      else next.add(num);
      return next;
    });
  };

  const closeMenu = (): void => {
    setMenuOpen(false);
    filterButtonRef.current?.focus();
  };

  const menuItems = (): HTMLElement[] =>
    Array.from(menuRef.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]') ?? []);

  const moveMenuFocus = (delta: number): void => {
    const items = menuItems();
    if (items.length === 0) return;
    const index = items.findIndex((item) => item === document.activeElement);
    items[(index + delta + items.length) % items.length]?.focus();
  };

  const jumpMenuFocus = (to: 'first' | 'last'): void => {
    const items = menuItems();
    items[to === 'first' ? 0 : items.length - 1]?.focus();
  };

  const onMenuKey = (event: KeyboardEvent<HTMLDivElement>): void => {
    switch (event.key) {
      case 'Escape':
        event.preventDefault();
        closeMenu();
        return;
      case 'ArrowDown':
        event.preventDefault();
        moveMenuFocus(1);
        return;
      case 'ArrowUp':
        event.preventDefault();
        moveMenuFocus(-1);
        return;
      // A vertical menu closes on Left and activates on Right in the ARIA pattern;
      // there are no submenus here, so Left simply dismisses.
      case 'ArrowLeft':
        event.preventDefault();
        closeMenu();
        return;
      case 'Home':
        event.preventDefault();
        jumpMenuFocus('first');
        return;
      case 'End':
        event.preventDefault();
        jumpMenuFocus('last');
        return;
      case 'Tab':
        // A menu is not part of the tab ring; close and return focus.
        event.preventDefault();
        closeMenu();
        return;
      default:
    }
  };

  const onRowKey = (event: KeyboardEvent<HTMLButtonElement>, index: number): void => {
    const next = nextIndex(event.key, index, flatRows.length);
    if (next < 0) return;
    event.preventDefault();
    setActiveRow(next);
    rowRefs.current[next]?.focus();
  };

  const chipLabels: Record<IssueListFilter, string> = {
    assigned: strings.issues.chipAssigned,
    created: strings.issues.chipCreated,
    mentioned: strings.issues.chipMentioned,
  };

  const groupTitles: Record<GroupId, string> = {
    active:
      filter === 'created'
        ? strings.issues.groupCreated
        : filter === 'mentioned'
          ? strings.issues.groupMentioned
          : strings.issues.groupAssigned,
    closed: strings.issues.groupClosed,
  };

  return (
    <section className="gc-issues" aria-label={strings.issues.panelAria}>
      {gate.view === 'loading' ? (
        <FileListSkeleton rows={8} />
      ) : gate.view === 'no-remote' ? (
        <EmptyState title={strings.issues.noRemoteTitle} hint={strings.issues.noRemoteBody} />
      ) : gate.view === 'signed-out' ? (
        <EmptyState
          title={strings.issues.signedOutTitle}
          hint={strings.issues.signedOutBody}
          action={
            <button
              type="button"
              className="gc-button gc-button--action"
              ref={connectRef}
              onClick={() => void connectAndRestore()}
            >
              {strings.issues.signInAction}
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
                  placeholder={strings.issues.searchPlaceholder}
                  aria-label={strings.issues.searchPlaceholder}
                  onChange={(event) => setQueryAndPersist(event.target.value)}
                />
              </div>

              <div className="gc-issues__filter-wrap" ref={menuRef}>
                <button
                  ref={filterButtonRef}
                  type="button"
                  className={`gc-icon-button gc-listbar__filter${labelFilter !== null ? ' gc-listbar__filter--active' : ''}`}
                  aria-label={strings.issues.filterLabel}
                  title={strings.issues.filterLabel}
                  aria-expanded={menuOpen}
                  onClick={() => setMenuOpen((v) => !v)}
                >
                  <Icon name="filter" />
                </button>
                {menuOpen && (
                  <div
                    className="gc-menu gc-issues__menu"
                    role="menu"
                    aria-label={strings.issues.filterLabel}
                    onKeyDown={onMenuKey}
                  >
                    <div className="gc-menu__group" role="group">
                      <div className="gc-menu__group-title">{strings.issues.filterState}</div>
                      {(['open', 'closed'] as const).map((id) => (
                        <button
                          key={id}
                          type="button"
                          className="gc-menu__item"
                          role="menuitemradio"
                          aria-checked={state === id}
                          onClick={() => {
                            selectAndPersist(filter, id);
                            setMenuOpen(false);
                          }}
                        >
                          <span className="gc-menu__icon" aria-hidden="true">
                            {state === id ? <Icon name="check" /> : null}
                          </span>
                          <span className="gc-menu__body">
                            <span className="gc-menu__label">
                              <span>
                                {id === 'open' ? strings.issues.filterOpen : strings.issues.filterClosed}
                              </span>
                              {id === 'open' && (
                                <span className="gc-issues__chip-count" aria-hidden="true">
                                  ({formatCount(issuesByFilter[filter].open.length, language)})
                                </span>
                              )}
                            </span>
                          </span>
                        </button>
                      ))}
                    </div>
                    <div className="gc-menu__group" role="group">
                      <div className="gc-menu__group-title">{strings.issues.filterLabel}</div>
                      {labels.length === 0 ? (
                        <div className="gc-issues__menu-empty">{strings.issues.emptyTitle}</div>
                      ) : (
                        labels.map((item) => (
                          <button
                            key={item.name}
                            type="button"
                            className="gc-menu__item"
                            role="menuitemcheckbox"
                            aria-checked={labelFilter === item.name}
                            onClick={() => {
                              const next = labelFilter === item.name ? null : item.name;
                              setLabelFilterAndPersist(next);
                              setMenuOpen(false);
                            }}
                          >
                            <span className="gc-menu__icon" aria-hidden="true">
                              {labelFilter === item.name ? <Icon name="check" /> : null}
                            </span>
                            <span className="gc-menu__body">
                              <span className="gc-menu__label">
                                <span>{sanitizeGitText(item.name)}</span>
                                <span className="gc-issues__chip-count" aria-hidden="true">
                                  ({formatCount(item.count, language)})
                                </span>
                              </span>
                            </span>
                          </button>
                        ))
                      )}
                      {(labelFilter !== null ||
                        query.length > 0 ||
                        filter !== 'assigned' ||
                        state !== 'open') && (
                        <>
                          <div className="gc-menu__separator" />
                          <button
                            type="button"
                            className="gc-menu__item"
                            role="menuitem"
                            onClick={() => {
                              clearFilters();
                              setMenuOpen(false);
                            }}
                          >
                            <span className="gc-menu__body">
                              <span className="gc-menu__label">{strings.issues.clearFilters}</span>
                            </span>
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>

          <div className="gc-issues__chips" role="group" aria-label={strings.issues.filterState}>
            {CHIP_ORDER.map((id) => {
              const label = chipLabels[id];
              // Assigned, Created, and Mentioned are the open lists.
              const rows = issuesByFilter[id].open;
              const count =
                loadedAt[id].open !== null ? formatCount(rows.length, language) : null;
              const name = count !== null ? `${label}, ${count}` : label;
              return (
                <button
                  key={id}
                  type="button"
                  className="gc-chip gc-issues__chip"
                  aria-pressed={filter === id}
                  aria-label={name}
                  title={name}
                  onClick={() => selectAndPersist(id)}
                >
                  <span>{label}</span>
                  {count !== null && (
                    <span className="gc-issues__chip-count" aria-hidden="true">
                      {count}
                    </span>
                  )}
                </button>
              );
            })}
          </div>

          {visible.length === 0 && closedVisible.length === 0 ? (
            <EmptyState
              title={
                filter === 'assigned' && state === 'open' && query === '' && labelFilter === null
                  ? strings.issues.emptyAssignedTitle
                  : strings.issues.emptyTitle
              }
              hint={
                filter === 'assigned' && state === 'open' && query === '' && labelFilter === null
                  ? strings.issues.emptyAssignedBody
                  : strings.issues.emptyBody
              }
              action={
                query !== '' || labelFilter !== null || filter !== 'assigned' || state !== 'open' ? (
                  <button type="button" className="gc-button gc-button--quiet" onClick={clearFilters}>
                    {strings.issues.clearFilters}
                  </button>
                ) : undefined
              }
            />
          ) : (
            <div className="gc-issues__groups">
              {groups.map((group) => {
                const rows = rowsByGroup[group];
                if (group === 'active' && rows.length === 0) return null;
                if (group === 'closed' && rows.length === 0 && loadedAt[filter].closed !== null) {
                  return null;
                }
                const title = groupTitles[group];
                const isOpen = expandedGroups.has(group);
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
                      {group === 'active' || loadedAt[filter].closed !== null ? (
                        <span className="gc-section__count">{formatCount(rows.length, language)}</span>
                      ) : null}
                    </div>
                    {isOpen && (
                      <ul className="gc-issues__rows" role="list">
                        {rows.map((issue) => {
                          const index = rowIndex.get(issue.number) ?? 0;
                          const isExpanded = expandedIssues.has(issue.number);
                          const previewId = `gc-issue-preview-${issue.number}`;
                          const title = sanitizeGitText(issue.title);
                          const author = sanitizeGitText(issue.author);
                          const labelNames = issue.labels.map((l) => sanitizeGitText(l.name)).join(', ');
                          const labelsPart = labelNames.length > 0 ? strings.issues.labelsJoin(labelNames) : '';
                          const rowName = strings.issues.rowAria(String(issue.number), title, labelsPart);
                          const excerpt = sanitizeGitText(issueExcerpt(issue.bodyExcerpt));

                          return (
                            <li key={issue.number} className="gc-issues__row">
                              <div className="gc-issues__row-main">
                                <button
                                  type="button"
                                  className="gc-issues__open"
                                  ref={(element) => {
                                    rowRefs.current[index] = element;
                                  }}
                                  tabIndex={index === active ? 0 : -1}
                                  aria-expanded={isExpanded}
                                  aria-controls={isExpanded ? previewId : undefined}
                                  aria-label={rowName}
                                  onClick={() => toggleIssue(issue.number)}
                                  onKeyDown={(event) => onRowKey(event, index)}
                                >
                                  <span className="gc-issues__state" aria-hidden="true">
                                    <Icon name="issue" />
                                  </span>
                                  <span className="gc-issues__body">
                                    <span className="gc-issues__title" title={title}>
                                      {title}
                                    </span>
                                    <span className="gc-issues__meta">
                                      <span>#{issue.number}</span>
                                      <span>{author}</span>
                                      <span>{relativeTime(issue.updatedAt, now, language)}</span>
                                      {issue.comments > 0 && (
                                        <span>{strings.issues.commentsCount(formatCount(issue.comments, language))}</span>
                                      )}
                                      {issue.state === 'closed' && (
                                        <span>
                                          {issue.stateReason === 'completed'
                                            ? strings.issues.reasonCompleted
                                            : issue.stateReason === 'not_planned'
                                              ? strings.issues.reasonNotPlanned
                                              : strings.issues.filterClosed}
                                        </span>
                                      )}
                                    </span>
                                    {issue.labels.length > 0 && (
                                      <span className="gc-issues__labels" aria-hidden="true">
                                        {issue.labels.map((l) => (
                                          <span
                                            key={l.name}
                                            className={`gc-issues__label gc-issues__label--${l.colorKey}`}
                                            title={sanitizeGitText(l.name)}
                                          >
                                            {sanitizeGitText(l.name)}
                                          </span>
                                        ))}
                                      </span>
                                    )}
                                  </span>
                                </button>
                                <button
                                  type="button"
                                  className="gc-issues__link"
                                  aria-hidden="true"
                                  title={strings.issues.openOnGitHub}
                                  tabIndex={-1}
                                  onClick={() => void openUrl(issue.url)}
                                >
                                  <Icon name="external" />
                                </button>
                              </div>

                              {isExpanded && (
                                <div
                                  id={previewId}
                                  role="region"
                                  aria-label={title}
                                  className="gc-issues__preview"
                                >
                                  {excerpt.length > 0 && (
                                    <p className="gc-issues__excerpt">{excerpt}</p>
                                  )}
                                  <div className="gc-issues__preview-actions">
                                    <button
                                      type="button"
                                      className="gc-button gc-button--action"
                                      onClick={() => void openUrl(issue.url)}
                                    >
                                      {strings.issues.openOnGitHub}
                                    </button>
                                  </div>
                                </div>
                              )}
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

      <footer className="gc-issues__footer">
        <span>
          {auth?.connected === true && auth.login !== null
            ? strings.issues.footerConnected(sanitizeGitText(auth.login))
            : strings.issues.footerNotConnected}
        </span>
        {quota !== null && <span className="gc-issues__quota">{quota}</span>}
      </footer>
    </section>
  );
}

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
      {strings.issues.signInAction}
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
