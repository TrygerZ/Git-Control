import { useEffect, type JSX } from 'react';
import type { LogLine, RunJobInfo } from '../messages';
import { logAriaLabel } from './actionsModel';
import { useActionsStore, useGitHubStore, useSettingsStore } from './store';
import { useT } from './useT';

export interface ActionJobLogProps {
  job: RunJobInfo;
}

/**
 * The log block for one job.
 *
 * Every line is a React text node: no Markdown, no links, no raw markup. The
 * text already had ANSI escapes, control characters, timestamps, PEM blocks, and
 * secrets removed on the host, so this component only maps a tone to a class.
 *
 * Error lines carry the word "error" for assistive tech through a visually hidden
 * span, so the danger colour is never the only signal.
 */
export function ActionJobLog({ job }: ActionJobLogProps): JSX.Element {
  const strings = useT();
  const language = useSettingsStore((s) => s.language);
  const openUrl = useGitHubStore((s) => s.openUrl);
  const entry = useActionsStore((s) => s.logs[job.id]);
  const loadLog = useActionsStore((s) => s.loadLog);

  // Self-loading: the panel is mounted only when the job is open, and an open
  // job that has no tail yet is exactly the case that needs a read. This covers
  // the auto-expanded failed job and the manual disclosure with one path, and
  // `loadLog` is idempotent so a remount costs nothing.
  useEffect(() => {
    // Only the first mount reads. An `error` entry must not re-arm this effect,
    // or a persistent failure would retry forever; the retry button is explicit.
    if (entry === undefined) void loadLog(job.id, { completed: true });
  }, [entry, job.id, loadLog]);

  const state = entry?.state ?? 'loading';
  const lines: LogLine[] = entry?.lines ?? [];

  return (
    <div
      className="gc-actions__log"
      role="region"
      tabIndex={0}
      aria-label={logAriaLabel(job.name, language)}
      aria-busy={state === 'loading'}
    >
      {state === 'loading' ? (
        <p className="gc-actions__log-note">{strings.actions.logLoading}</p>
      ) : state === 'error' ? (
        <>
          <p className="gc-actions__log-note">{strings.actions.logFailed}</p>
          <button
            type="button"
            className="gc-button gc-button--quiet gc-actions__log-open"
            onClick={() => void loadLog(job.id, { completed: true })}
          >
            {strings.actions.retry}
          </button>
        </>
      ) : state === 'empty' ? (
        <p className="gc-actions__log-note">{strings.actions.logEmpty}</p>
      ) : state === 'expired' ? (
        <p className="gc-actions__log-note">{strings.actions.logExpired}</p>
      ) : state === 'tooLarge' ? (
        <p className="gc-actions__log-note">{strings.actions.logTooLarge}</p>
      ) : state === 'binary' ? (
        <p className="gc-actions__log-note">{strings.actions.logBinary}</p>
      ) : state === 'blocked' ? (
        <p className="gc-actions__log-note">{strings.actions.logRedirectBlocked}</p>
      ) : (
        <>
          {entry?.headCut === true && (
            <p className="gc-actions__log-note">{strings.actions.logHeadCut(String(lines.length))}</p>
          )}
          <pre className="gc-actions__log-body">
            {lines.map((line, index) => (
              <span key={index} className={`gc-actions__log-line gc-actions__log-line--${line.tone}`}>
                {line.tone === 'error' && (
                  <span className="gc-visually-hidden">{strings.actions.logErrorWord}: </span>
                )}
                {line.text}
                {'\n'}
              </span>
            ))}
          </pre>
        </>
      )}

      {job.url !== '' && (
        <button
          type="button"
          className="gc-button gc-button--quiet gc-actions__log-open"
          onClick={() => void openUrl(job.url)}
        >
          {strings.actions.openFullLog}
        </button>
      )}
    </div>
  );
}
