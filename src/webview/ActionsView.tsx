import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
} from 'react';
import type { Lang } from '../messages';
import { filterByWorkflow, groupRuns, needsPolling } from './actionsModel';
import { ActionRunRow } from './ActionRunRow';
import { ActionsFilters } from './ActionsFilters';
import { restoreTarget } from './focusTrap';
import { apiQuotaLabel, countdown, formatCount, sanitizeGitText } from './format';
import { githubGate, type GateBanner } from './githubGate';
import { applyResult, DEFAULT_POLL_CONFIG, nextPoll, type PollState } from './pollPlan';
import {
  ACTIONS_PAGE_SIZE,
  useActionsStore,
  useGitHubStore,
  useRepoStore,
  useRouteStore,
  useSettingsStore,
} from './store';
import { EmptyState, FileListSkeleton, Icon, InfoBanner } from './ui';
import { useT } from './useT';

const TICK_MS = 1000;

export function ActionsView(): JSX.Element {
  const strings = useT();
  const language = useSettingsStore((s) => s.language);
  const auth = useGitHubStore((s) => s.auth);
  const linkage = useGitHubStore((s) => s.linkage);
  const rateLimit = useGitHubStore((s) => s.rateLimit);
  const ghLoading = useGitHubStore((s) => s.loading);
  const ghError = useGitHubStore((s) => s.error);
  const connect = useGitHubStore((s) => s.connect);

  const runs = useActionsStore((s) => s.runs);
  const branch = useActionsStore((s) => s.branch);
  const workflowId = useActionsStore((s) => s.workflowId);
  const actionsLoading = useActionsStore((s) => s.loading);
  const actionsError = useActionsStore((s) => s.error);
  const load = useActionsStore((s) => s.load);

  const route = useRouteStore((s) => s.route);
  const status = useRepoStore((s) => s.status);

  const [expandedSections, setExpandedSections] = useState<ReadonlySet<string>>(
    () => new Set(['thisBranch', 'allBranches']),
  );
  const [now, setNow] = useState(() => Date.now());

  const connectRef = useRef<HTMLButtonElement>(null);

  const needsTick = rateLimit !== null && rateLimit.remaining === 0 && rateLimit.resetAt !== null;
  useEffect(() => {
    if (!needsTick) return undefined;
    const timer = setTimeout(() => setNow(Date.now()), TICK_MS);
    return () => clearTimeout(timer);
  }, [needsTick, now]);

  useEffect(() => {
    if (route.id === 'actions' && auth?.connected === true) {
      void load({ branch, workflowId });
    }
  }, [route.id, auth?.connected, branch, workflowId, load]);

  useEffect(() => {
    if (route.id !== 'actions' || !needsPolling(runs)) return undefined;

    let timer: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;
    let pollState: PollState = {
      visible: true,
      active: true,
      inFlight: false,
      consecutiveUnchanged: 0,
      consecutiveErrors: 0,
      rateLimited: rateLimit?.remaining === 0,
      offline: rateLimit?.offline === true,
    };

    const schedule = (): void => {
      if (cancelled) return;
      const decision = nextPoll(pollState, DEFAULT_POLL_CONFIG);
      if (!decision.poll) return;

      timer = setTimeout(async () => {
        if (cancelled) return;
        const prev = useActionsStore.getState().runs;
        pollState = { ...pollState, inFlight: true };
        try {
          await load({ force: true });
          const current = useActionsStore.getState().runs;
          const currentRl = useGitHubStore.getState().rateLimit;
          const changed =
            current !== prev &&
            (current.length !== prev.length ||
              current.some(
                (r, i) =>
                  r.id !== prev[i]?.id ||
                  r.status !== prev[i]?.status ||
                  r.conclusion !== prev[i]?.conclusion,
              ));
          pollState = applyResult(pollState, changed ? 'changed' : 'unchanged', {
            rateLimited: currentRl?.remaining === 0,
            offline: currentRl?.offline === true,
          });
        } catch {
          const currentRl = useGitHubStore.getState().rateLimit;
          pollState = applyResult(pollState, 'error', {
            rateLimited: currentRl?.remaining === 0,
            offline: currentRl?.offline === true,
          });
        } finally {
          pollState = { ...pollState, inFlight: false };
          if (!cancelled && needsPolling(useActionsStore.getState().runs)) {
            schedule();
          }
        }
      }, decision.delayMs);
    };

    schedule();

    return () => {
      cancelled = true;
      if (timer !== null) {
        clearTimeout(timer);
      }
    };
  }, [route.id, needsPolling(runs), load]);

  const loading = ghLoading || actionsLoading;
  const error = actionsError ?? ghError;
  const gate = githubGate({
    view: 'actions',
    auth,
    linkage,
    rateLimit,
    error,
    loading,
    hasData: runs.length > 0,
  });

  const currentBranch = status?.branch ?? null;
  const filteredRuns = useMemo(() => filterByWorkflow(runs, workflowId), [runs, workflowId]);
  const groups = useMemo(() => groupRuns(filteredRuns, currentBranch), [filteredRuns, currentBranch]);

  const toggleSection = (id: 'thisBranch' | 'allBranches'): void => {
    setExpandedSections((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const setConnectButton = (element: HTMLButtonElement | null): void => {
    connectRef.current = element;
  };

  const connectAndRestore = async (): Promise<void> => {
    await connect();
    if (restoreTarget(connectRef.current !== null) === 'connect') connectRef.current?.focus();
  };

  const quota = apiQuotaLabel(rateLimit, language);

  return (
    <section className="gc-actions" aria-label={strings.actions.panelAria}>
      {gate.view === 'loading' ? (
        <FileListSkeleton rows={8} />
      ) : gate.view === 'signed-out' ? (
        <EmptyState
          title={strings.actions.signedOutTitle}
          hint={strings.actions.signedOutBody}
          action={
            <button
              type="button"
              className="gc-button gc-button--action"
              ref={connectRef}
              onClick={() => void connectAndRestore()}
            >
              {strings.actions.signInAction}
            </button>
          }
        />
      ) : gate.view === 'no-remote' ? (
        <EmptyState title={strings.prs.noRemoteTitle} hint={strings.prs.noRemoteBody} />
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

          <ActionsFilters />

          {filteredRuns.length === 0 ? (
            <EmptyState
              title={
                workflowId !== null
                  ? strings.actions.emptyFilter
                  : branch !== null
                    ? strings.actions.emptyBranch
                    : strings.actions.emptyTitle
              }
              hint={
                workflowId === null && branch === null
                  ? strings.actions.emptyBody
                  : undefined
              }
              action={
                <button
                  type="button"
                  className="gc-button gc-button--quiet"
                  onClick={() => void load({ force: true })}
                >
                  {strings.actions.retry}
                </button>
              }
            />
          ) : (
            <div className="gc-actions__groups">
              {groups.thisBranch.length > 0 && (
                <section className="gc-section" aria-label={strings.actions.groupThisBranch}>
                  <div className="gc-section__head">
                    <h3 className="gc-section__title">
                      <button
                        type="button"
                        className="gc-section__toggle"
                        aria-expanded={expandedSections.has('thisBranch')}
                        aria-label={
                          expandedSections.has('thisBranch')
                            ? strings.pending.collapseSectionAria(strings.actions.groupThisBranch)
                            : strings.pending.expandSectionAria(strings.actions.groupThisBranch)
                        }
                        onClick={() => toggleSection('thisBranch')}
                      >
                        <span className="gc-section__twisty" aria-hidden="true">
                          <Icon
                            name={
                              expandedSections.has('thisBranch')
                                ? 'chevron-down'
                                : 'chevron-right'
                            }
                          />
                        </span>
                        <span className="gc-section__name">{strings.actions.groupThisBranch}</span>
                      </button>
                    </h3>
                    <span className="gc-section__count">
                      {formatCount(groups.thisBranch.length, language)}
                    </span>
                  </div>
                  {expandedSections.has('thisBranch') && (
                    <ul className="gc-actions__rows" role="list">
                      {groups.thisBranch.map((run) => (
                        <ActionRunRow key={run.id} run={run} now={now} />
                      ))}
                    </ul>
                  )}
                </section>
              )}

              {groups.others.length > 0 && (
                <section className="gc-section" aria-label={strings.actions.groupAllBranches}>
                  <div className="gc-section__head">
                    <h3 className="gc-section__title">
                      <button
                        type="button"
                        className="gc-section__toggle"
                        aria-expanded={expandedSections.has('allBranches')}
                        aria-label={
                          expandedSections.has('allBranches')
                            ? strings.pending.collapseSectionAria(strings.actions.groupAllBranches)
                            : strings.pending.expandSectionAria(strings.actions.groupAllBranches)
                        }
                        onClick={() => toggleSection('allBranches')}
                      >
                        <span className="gc-section__twisty" aria-hidden="true">
                          <Icon
                            name={
                              expandedSections.has('allBranches')
                                ? 'chevron-down'
                                : 'chevron-right'
                            }
                          />
                        </span>
                        <span className="gc-section__name">{strings.actions.groupAllBranches}</span>
                      </button>
                    </h3>
                    <span className="gc-section__count">
                      {formatCount(groups.others.length, language)}
                    </span>
                  </div>
                  {expandedSections.has('allBranches') && (
                    <ul className="gc-actions__rows" role="list">
                      {groups.others.map((run) => (
                        <ActionRunRow key={run.id} run={run} now={now} />
                      ))}
                    </ul>
                  )}
                </section>
              )}
            </div>
          )}

          <footer className="gc-actions__footer">
            {runs.length === ACTIONS_PAGE_SIZE && (
              <span>{strings.actions.latestOnly(String(ACTIONS_PAGE_SIZE))}</span>
            )}
            {quota !== null && <span className="gc-actions__quota">{quota}</span>}
          </footer>
        </>
      )}
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
      {strings.actions.signInAction}
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
