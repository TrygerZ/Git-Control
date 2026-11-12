/**
 * Clean up merged branches dialog (P20, frame 61).
 *
 * Lists the branches `selectCleanupCandidates` says are safe, lets the user tick
 * which ones go, and shows the exact command for the current selection before
 * anything runs. The command preview is the same teaching device the guard dialog
 * uses: a branch delete is a thing that exists outside this extension, and seeing
 * the line is how the button stops being a mystery.
 *
 * The dialog cannot delete anything itself. It hands names to
 * `useBranchesStore.deleteBranches`, which runs one guarded mutation per branch.
 * That split is deliberate: the guard and the host stay the only things that
 * decide, and this file stays a list of checkboxes.
 *
 * Frame 61 draws three rows and a remote checkbox. The remote row is absent when
 * no candidate has a remote copy, because a checkbox that cannot do anything is a
 * dead control (R2).
 */
import { useEffect, useId, useMemo, useRef, useState, type JSX } from 'react';
import { gitCommandOf, relativeTime, sanitizeGitText } from './format';
import { useDialogFocusTrap } from './useDialogFocusTrap';
import { useT } from './useT';
import { Icon } from './ui';
import { useSettingsStore } from './store';
import type { CleanupCandidate } from '../branchCleanup';

export interface CleanupDialogProps {
  candidates: readonly CleanupCandidate[];
  /** Remote offered by the "also delete" checkbox, or null when none qualifies. */
  remote: string | null;
  onDelete(names: readonly string[], remote: string | null): void;
  onCancel(): void;
}

export function CleanupDialog({ candidates, remote, onDelete, onCancel }: CleanupDialogProps): JSX.Element {
  const strings = useT();
  const language = useSettingsStore((s) => s.language);
  const { dialogRef, onKeyDown } = useDialogFocusTrap(onCancel);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef<Element | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(
    () => new Set(candidates.map((c) => c.name)),
  );
  const [withRemote, setWithRemote] = useState(false);

  const titleId = useId();
  const descId = useId();

  useEffect(() => {
    returnFocus.current = document.activeElement;
    // Cancel takes focus, matching the guard dialog: the loudest thing here is the
    // way out, and a reflex Enter must not delete three branches.
    cancelRef.current?.focus();
    return () => {
      const previous = returnFocus.current;
      if (previous instanceof HTMLElement) previous.focus();
    };
  }, []);

  const chosen = useMemo(
    () => candidates.filter((c) => selected.has(c.name)).map((c) => c.name),
    [candidates, selected],
  );
  const allChosen = chosen.length === candidates.length && candidates.length > 0;

  const toggle = (name: string): void => {
    const next = new Set(selected);
    if (next.has(name)) next.delete(name);
    else next.add(name);
    setSelected(next);
  };

  const commands = chosen.map((name) => gitCommandOf({ action: 'branch-delete', branch: name }));

  return (
    <div className="gc-modal-backdrop">
      <div
        className="gc-modal gc-cleanup"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descId}
        ref={dialogRef}
        onKeyDown={onKeyDown}
      >
        <div className="gc-cleanup__head">
          <span className="gc-cleanup__badge" aria-hidden="true">
            <Icon name="trash" />
          </span>
          <div className="gc-cleanup__titles">
            <h2 className="gc-cleanup__title" id={titleId}>
              {strings.cleanup.title}
            </h2>
            <p className="gc-cleanup__intro" id={descId}>
              {strings.cleanup.intro}
            </p>
          </div>
          <button
            type="button"
            className="gc-icon-button gc-cleanup__close"
            aria-label={strings.guard.cancelButton}
            onClick={onCancel}
          >
            <Icon name="close" />
          </button>
        </div>

        {candidates.length === 0 ? (
          <p className="gc-cleanup__empty">{strings.cleanup.empty}</p>
        ) : (
          <>
            <ul className="gc-cleanup__list" role="list">
              {candidates.map((candidate) => {
                const checked = selected.has(candidate.name);
                const age =
                  candidate.mergedAt === null
                    ? null
                    : relativeTime(candidate.mergedAt, Date.now(), language);
                return (
                  <li key={candidate.name} className="gc-cleanup__row">
                    <label className="gc-cleanup__label">
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggle(candidate.name)}
                        aria-label={strings.cleanup.rowAria(
                          sanitizeGitText(candidate.name),
                          age === null ? strings.branches.chipMerged : strings.cleanup.mergedAgo(age),
                        )}
                      />
                      <Icon name="git-branch" />
                      <span className="gc-cleanup__name" title={sanitizeGitText(candidate.name)}>
                        {sanitizeGitText(candidate.name)}
                      </span>
                    </label>
                    <span className="gc-cleanup__fact">
                      {candidate.upstreamGone
                        ? strings.cleanup.upstreamGone
                        : age === null
                          ? ''
                          : strings.cleanup.mergedAgo(age)}
                    </span>
                  </li>
                );
              })}
            </ul>

            {/* Only offered when at least one candidate actually has a remote copy. */}
            {remote !== null && candidates.some((c) => c.remote === remote) && (
              <label className="gc-checkbox gc-cleanup__remote">
                <input
                  type="checkbox"
                  checked={withRemote}
                  onChange={(event) => setWithRemote(event.target.checked)}
                />
                <span className="gc-checkbox__text">
                  <span>{strings.cleanup.alsoRemote(sanitizeGitText(remote))}</span>
                  <span className="gc-checkbox__hint">{strings.cleanup.remoteNeedsSecond}</span>
                </span>
              </label>
            )}

            {commands.length > 0 && (
              <div className="gc-cleanup__command">
                <span className="gc-cleanup__command-label">
                  <Icon name="chevron-right" />
                  <span>{strings.cleanup.commandLabel}</span>
                </span>
                <code>
                  {commands.map((line) => (
                    <span key={line} className="gc-cleanup__command-line">
                      {line}
                    </span>
                  ))}
                </code>
              </div>
            )}

            {candidates.length > 5 && (
              <button
                type="button"
                className="gc-button gc-button--quiet gc-cleanup__all"
                onClick={() =>
                  setSelected(allChosen ? new Set() : new Set(candidates.map((c) => c.name)))
                }
              >
                {allChosen ? strings.cleanup.clearAll : strings.cleanup.selectAll}
              </button>
            )}
          </>
        )}

        <div className="gc-modal__actions">
          <button
            ref={cancelRef}
            type="button"
            className="gc-button gc-button--primary gc-button--lg"
            title={strings.guard.cancelButton}
            onClick={onCancel}
          >
            {strings.guard.cancelButton}
          </button>
          <button
            type="button"
            className="gc-button gc-button--danger"
            disabled={chosen.length === 0}
            onClick={() => onDelete(chosen, withRemote ? remote : null)}
          >
            <Icon name="trash" />
            {strings.cleanup.deleteN(String(chosen.length))}
          </button>
        </div>
      </div>
    </div>
  );
}
