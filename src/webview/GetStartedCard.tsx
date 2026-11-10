/**
 * Get started checklist card (P16), frames 103 (active) and 104 (done).
 *
 * Every decision is made by the pure helpers in `onboarding.ts`; this component
 * only reads the stores and draws. The two mutations reuse the store actions the
 * rest of the view already sends, so the card issues no request of its own.
 */
import { useEffect, useRef, type JSX } from 'react';
import { sanitizeGitText } from './format';
import {
  cardPhase,
  compareUrl,
  computeSteps,
  progress,
  type OnboardingStep,
  type StepId,
} from './onboarding';
import { useGitHubStore, useOperationStore, useRepoStore, useSettingsStore } from './store';
import { Icon } from './ui';
import { useT } from './useT';

/** The done card lingers this long before it hides itself. */
const HIDE_DELAY_MS = 3000;

export function GetStartedCard({ onDismissed }: { onDismissed?: () => void }): JSX.Element | null {
  const strings = useT();
  const status = useRepoStore((s) => s.status);
  const remotes = useRepoStore((s) => s.remotes);
  const loadRemotes = useRepoStore((s) => s.loadRemotes);
  const auth = useGitHubStore((s) => s.auth);
  const linkage = useGitHubStore((s) => s.linkage);
  const pullRequests = useGitHubStore((s) => s.pullRequests);
  const pullRequestsLoadedAt = useGitHubStore((s) => s.pullRequestsLoadedAt);
  const closedPullRequests = useGitHubStore((s) => s.closedPullRequests);
  const closedLoaded = useGitHubStore((s) => s.closedLoaded);
  const loadClosedPullRequests = useGitHubStore((s) => s.loadClosedPullRequests);
  const connect = useGitHubStore((s) => s.connect);
  const openUrl = useGitHubStore((s) => s.openUrl);
  const checklistDismissed = useSettingsStore((s) => s.checklistDismissed);
  const checklistForced = useSettingsStore((s) => s.checklistForced);
  const setChecklistDismissed = useSettingsStore((s) => s.setChecklistDismissed);
  const runAction = useOperationStore((s) => s.runAction);
  const busy = useOperationStore((s) => s.state === 'loading');

  const branch = status?.branch ?? null;
  const firstRemote = remotes === null ? null : remotes[0] ?? null;
  // The remote the branch already tracks names the push target; otherwise the
  // first configured remote does. Both are real names, never derived from refs.
  const remote =
    status?.upstream === null || status?.upstream === undefined
      ? firstRemote?.name ?? null
      : status?.upstream.split('/')[0] ?? null;
  // `null` while the configured remotes are unread: the card hides rather than
  // guessing. A remote added but never fetched still counts.
  const hasRemote = remotes === null ? null : remotes.length > 0;

  // Depends on the cache value, not just the action: `event/repoChanged` drops
  // the cache on every mutation (the commit step is one), and a mount-only
  // effect would leave the card hidden until the route was left and re-entered.
  useEffect(() => {
    if (remotes === null) void loadRemotes();
  }, [remotes, loadRemotes]);

  const steps = computeSteps({
    head: status?.head ?? null,
    branch,
    upstream: status?.upstream ?? null,
    hasRemote,
    github: {
      linked: linkage?.available === true,
      connected: auth?.connected === true,
      webUrl: linkage?.webUrl ?? null,
    },
    // The store's `[]` cannot be told apart from a loaded empty list, so the
    // loaded-at stamp decides: unknown stays unknown and the step stays put
    // instead of flipping 3 of 4 to 4 of 4 a moment later. Merged rows only
    // exist in the closed list, which the effect below loads once.
    pullRequests:
      auth?.connected === true || linkage?.available === true
        ? pullRequestsLoadedAt === null ? null : [...pullRequests, ...(closedLoaded ? closedPullRequests : [])]
        : null,
    createPrAvailable: false,
  });

  /*
   * The done card only appears when the user saw the incomplete one. The ref is
   * read during render and written after the phase is known, so the first
   * all-done render at startup still hides.
   */
  const sawIncomplete = useRef(false);
  const phase = cardPhase(steps, {
    dismissed: checklistDismissed,
    sawIncomplete: sawIncomplete.current,
    forced: checklistForced,
  });
  if (phase === 'active') sawIncomplete.current = true;

  useEffect(() => {
    if (phase !== 'done') return undefined;
    const timer = setTimeout(() => setChecklistDismissed(true), HIDE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [phase, setChecklistDismissed]);

  /*
   * A merged pull request only lives in the closed list, so the PR step can
   * never turn done until that list has been read once. The store action is
   * idempotent (`closedLoaded` or an in-flight read returns early), so a plain
   * effect on the step state is enough; no polling.
   */
  const prStep = steps?.find((step) => step.id === 'pull-request') ?? null;
  const prSettled = prStep === null || prStep.state === 'done' || prStep.state === 'na';
  const linkageAvailable = linkage?.available === true;
  useEffect(() => {
    if (closedLoaded || !linkageAvailable || prSettled) return;
    void loadClosedPullRequests();
  }, [closedLoaded, linkageAvailable, prSettled, loadClosedPullRequests]);

  if (phase === 'hidden' || steps === null) return null;

  const { done, total } = progress(steps);
  const pct = total === 0 ? 0 : Math.round((done / total) * 100);
  const visible = steps.filter((step) => step.state !== 'na');

  const titleOf = (id: StepId): string => {
    switch (id) {
      case 'connect':
        return strings.onboarding.connectTitle;
      case 'commit':
        return strings.onboarding.commitTitle;
      case 'publish':
        return strings.onboarding.publishTitle;
      case 'pull-request':
        return strings.onboarding.prTitle;
    }
  };

  const descOf = (step: OnboardingStep): string => {
    switch (step.id) {
      case 'connect':
        return step.state === 'done'
          ? strings.onboarding.connectDone(auth?.login ?? '')
          : strings.onboarding.connectTodo;
      case 'commit':
        return strings.onboarding.commitDesc;
      case 'publish': {
        const name = sanitizeGitText(branch ?? '');
        return linkage?.available === true
          ? strings.onboarding.publishDescGithub(name)
          : strings.onboarding.publishDescRemote(name);
      }
      case 'pull-request':
        return strings.onboarding.prDesc;
    }
  };

  const stateWordOf = (step: OnboardingStep): string => {
    if (step.state === 'done') return strings.onboarding.stepDoneAria;
    if (step.state === 'current') return strings.onboarding.stepCurrentAria;
    return strings.onboarding.stepTodoAria;
  };

  const actionOf = (step: OnboardingStep): JSX.Element | null => {
    if (step.state !== 'current' || step.action === null) return null;
    const action = step.action;
    switch (action.kind) {
      case 'connect':
        return (
          <button
            type="button"
            className="gc-button gc-button--quiet"
            disabled={busy}
            onClick={() => void connect()}
          >
            {strings.onboarding.actionConnect}
          </button>
        );
      case 'publish':
        if (remote === null || branch === null) return null;
        return (
          <button
            type="button"
            className="gc-button gc-button--primary"
            disabled={busy}
            onClick={() =>
              void runAction({ action: 'push', remote, branch, setUpstream: true })
            }
          >
            {strings.onboarding.actionPublish}
          </button>
        );
      case 'open-compare':
        return (
          <button
            type="button"
            className="gc-button gc-button--quiet"
            disabled={busy}
            onClick={() =>
              // Recomputed at the click site from current store state, never a
              // stale URL baked into a render; the action's URL is the fallback.
              void openUrl(compareUrl(linkage?.webUrl ?? null, branch) ?? action.url)
            }
          >
            {strings.onboarding.actionOpenCompare}
          </button>
        );
      case 'create-pr':
        // The dialog ships in P22; the branch exists so the switch stays exhaustive.
        return null;
    }
  };

  return (
    <section className="gc-started" aria-label={strings.onboarding.title}>
      <div className="gc-started__head">
        <Icon name="sparkle" />
        <h2 className="gc-started__title">
          {phase === 'done' ? strings.onboarding.doneTitle : strings.onboarding.title}
        </h2>
        <span className="gc-started__count">
          {strings.onboarding.progress(String(done), String(total))}
        </span>
        <button
          type="button"
          className="gc-icon-button gc-started__dismiss"
          aria-label={strings.onboarding.dismissAria}
          onClick={() => {
            setChecklistDismissed(true);
            onDismissed?.();
          }}
        >
          <Icon name="close" />
        </button>
      </div>

      <div
        className={
          phase === 'done' ? 'gc-started__bar gc-started__bar--done' : 'gc-started__bar'
        }
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={done}
        aria-valuetext={strings.onboarding.progressAria(String(done), String(total))}
        aria-label={strings.onboarding.title}
      >
        <span
          className="gc-started__bar-fill"
          style={{ width: `${phase === 'done' ? 100 : pct}%` }}
        />
      </div>

      <ol className="gc-started__steps">
        {visible.map((step) => (
          <li key={step.id} className={`gc-started__step gc-started__step--${step.state}`}>
            <span className="gc-started__mark" aria-hidden="true">
              {step.state === 'done' ? (
                <Icon name="check" />
              ) : step.state === 'current' ? (
                <Icon name="circle-filled" />
              ) : null}
            </span>
            <span className="gc-visually-hidden">{stateWordOf(step)}</span>
            <div className="gc-started__body">
              <strong>{titleOf(step.id)}</strong>
              <span className="gc-started__desc">{descOf(step)}</span>
            </div>
            {step.state === 'current' && step.action !== null && (
              <span className="gc-started__action">{actionOf(step)}</span>
            )}
          </li>
        ))}
      </ol>

      {phase === 'done' && (
        <p className="gc-started__note" role="status">
          {strings.onboarding.doneNote}
        </p>
      )}
    </section>
  );
}
