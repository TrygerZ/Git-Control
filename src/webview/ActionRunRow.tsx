import type { JSX } from 'react';
import type { Catalog } from './i18n';
import type { Lang, RunConclusion, RunJobInfo, RunStatus, WorkflowRunInfo } from '../messages';
import { durationText, formatDuration, metaLine, toneOf, type RunTone } from './actionsModel';
import { sanitizeGitText } from './format';
import { Icon, type IconName } from './ui';
import { useActionsStore, useGitHubStore, useSettingsStore } from './store';
import { useT } from './useT';

function runStatusIcon(tone: RunTone): IconName {
  switch (tone) {
    case 'running':
      return 'status-running';
    case 'queued':
      return 'status-queued';
    case 'success':
      return 'check';
    case 'danger':
      return 'error';
    case 'warning':
      return 'warning';
    case 'neutral':
    default:
      return 'status-skipped';
  }
}

function runStatusWord(
  status: RunStatus,
  conclusion: RunConclusion,
  strings: Catalog,
): string {
  if (status === 'in_progress') return strings.actions.statusRunning;
  if (
    status === 'queued' ||
    status === 'waiting' ||
    status === 'requested' ||
    status === 'pending'
  ) {
    return strings.actions.statusQueued;
  }
  switch (conclusion) {
    case 'success':
      return strings.actions.statusSuccess;
    case 'failure':
    case 'timed_out':
    case 'startup_failure':
      return strings.actions.statusFailed;
    case 'action_required':
      return strings.actions.statusActionRequired;
    case 'cancelled':
      return strings.actions.statusCancelled;
    case 'skipped':
    default:
      return strings.actions.statusSkipped;
  }
}

/** A job's duration reuses the run formatter so the two can never drift. */
function jobDuration(job: RunJobInfo, now: number, lang: Lang): string {
  const finished = job.status === 'completed' && job.completedAt !== null;
  return formatDuration(job.startedAt, finished ? Date.parse(job.completedAt as string) : now, !finished, lang);
}

export interface ActionRunRowProps {
  run: WorkflowRunInfo;
  now: number;
}

export function ActionRunRow({ run, now }: ActionRunRowProps): JSX.Element {
  const strings = useT();
  const language = useSettingsStore((s) => s.language);
  const openUrl = useGitHubStore((s) => s.openUrl);
  const expanded = useActionsStore((s) => s.expanded.has(run.id));
  const jobs = useActionsStore((s) => s.jobsByRun[run.id]);
  const isLoadingJobs = useActionsStore((s) => s.jobsLoading.has(run.id));
  const isErrorJobs = useActionsStore((s) => s.jobsError.has(run.id));
  const toggleRun = useActionsStore((s) => s.toggleRun);
  const loadJobs = useActionsStore((s) => s.loadJobs);

  const jobsId = `gc-actions-jobs-${run.id}`;
  const tone = toneOf(run);
  const icon = runStatusIcon(tone);
  const word = runStatusWord(run.status, run.conclusion, strings);

  const handleToggle = (): void => {
    if (!expanded) {
      void loadJobs(run.id);
    }
    toggleRun(run.id);
  };

  return (
    <li className="gc-actions__row">
      <div className="gc-actions__row-head">
        <button
          type="button"
          className="gc-actions__toggle"
          aria-expanded={expanded}
          aria-controls={expanded ? jobsId : undefined}
          onClick={handleToggle}
        >
          <span className="gc-actions__twisty" aria-hidden="true">
            <Icon name={expanded ? 'chevron-down' : 'chevron-right'} />
          </span>
          <span className={`gc-actions__status gc-actions__status--${tone}`} aria-hidden="true">
            <Icon name={icon} />
          </span>
          <span className="gc-visually-hidden">{word}</span>
          <span className="gc-actions__body">
            <span className="gc-actions__title">{sanitizeGitText(run.title || run.name)}</span>
            <span className="gc-actions__meta">{metaLine(run, language)}</span>
          </span>
          <span className="gc-actions__duration">{durationText(run, now, language)}</span>
        </button>
        {run.url !== '' && (
          <button
            type="button"
            className="gc-actions__link"
            title={strings.actions.openOnGitHub}
            aria-label={strings.actions.openOnGitHub}
            onClick={() => void openUrl(run.url)}
          >
            <Icon name="external" />
          </button>
        )}
      </div>

      {expanded && (
        <ul className="gc-actions__jobs" id={jobsId} role="list">
          {isLoadingJobs ? (
            <li className="gc-actions__jobs-note">{strings.actions.jobsLoading}</li>
          ) : isErrorJobs ? (
            <li className="gc-actions__jobs-note">{strings.actions.jobsFailed}</li>
          ) : jobs !== undefined ? (
            jobs.map((job) => {
              const jobTone = toneOf(job);
              const jobIcon = runStatusIcon(jobTone);
              const jobWord = runStatusWord(job.status, job.conclusion, strings);
              return (
                <li key={job.id} className="gc-actions__job">
                  <span
                    className={`gc-actions__status gc-actions__status--${jobTone}`}
                    aria-hidden="true"
                  >
                    <Icon name={jobIcon} />
                  </span>
                  <span className="gc-visually-hidden">{jobWord}</span>
                  <span className="gc-actions__job-name">{sanitizeGitText(job.name)}</span>
                  <span className="gc-actions__duration">{jobDuration(job, now, language)}</span>
                </li>
              );
            })
          ) : null}
        </ul>
      )}
    </li>
  );
}
