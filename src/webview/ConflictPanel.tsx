/**
 * Conflict panel (FEAT-04/06).
 *
 * Every conflict code is explained in Indonesian, because "UU" means nothing to
 * someone who is avoiding the terminal. `Lanjutkan merge` stays disabled until
 * the conflict list is empty, and the reason is always visible — a disabled
 * button with no explanation is worse than no button.
 *
 * Accessibility: each row's buttons name the file they act on, so a ten-file
 * conflict list does not read as ten identical `Selesaikan` buttons.
 */
import { type JSX } from 'react';
import {
  conflictActionLabel,
  conflictLabel,
  formatCount,
  operationLabel,
  sanitizeGitText,
} from './format';
import { useT } from './useT';
import { bridge } from './bridge';
import { toErrorBody, useChangesStore, useOperationStore, useSettingsStore } from './store';
import { EmptyState, InfoBanner } from './ui';
import type { ConflictEntry, OperationState, RepoStatus } from '../messages';

/** Banner shown above the canvas while any git operation is unfinished. */
export function OperationBanner({ status }: { status: RepoStatus | null }): JSX.Element | null {
  const strings = useT();
  const language = useSettingsStore((x) => x.language);
  const runAction = useOperationStore((st) => st.runAction);
  if (status === null || status.operation === 'idle') return null;
  const resolved = status.conflicts.length === 0;
  const blockedId = 'gc-continue-blocked';

  return (
    <InfoBanner tone="warning" glyph="warning">
      <strong>{operationLabel(status.operation, language)}</strong>
      <span>
        {resolved
          ? strings.conflict.allConflictsResolved
          : strings.conflict.remainingConflicts(formatCount(status.conflicts.length, language))}
      </span>
      <span className="gc-banner__buttons">
        <button
          type="button"
          className="gc-button gc-button--primary"
          disabled={!resolved}
          // The reason for the disabled state is announced, not only hovered.
          aria-describedby={resolved ? undefined : blockedId}
          title={strings.conflict.continueMergeTitle}
          onClick={() => void runAction({ action: 'merge-continue' })}
        >
          {strings.conflict.continueMerge}
        </button>
        <button
          type="button"
          className="gc-button"
          title={strings.conflict.abortMergeTitle}
          onClick={() => void runAction({ action: 'merge-abort' })}
        >
          {strings.conflict.abortMerge}
        </button>
      </span>
      {!resolved && (
        <span className="gc-help-text" id={blockedId}>
          {strings.conflict.resolveAllFirst}
        </span>
      )}
    </InfoBanner>
  );
}

interface Props {
  conflicts: readonly ConflictEntry[];
  operation: OperationState;
}

export function ConflictPanel({ conflicts, operation }: Props): JSX.Element {
  const strings = useT();
  const language = useSettingsStore((x) => x.language);
  const stage = useChangesStore((st) => st.stage);
  const busy = useChangesStore((st) => st.busy);
  const runAction = useOperationStore((st) => st.runAction);
  const pushToast = useOperationStore((st) => st.pushToast);
  const blockedId = 'gc-conflicts-blocked';

  const openMergeEditor = async (path: string): Promise<void> => {
    try {
      await bridge.request('actions/openDiff', { path });
    } catch (err) {
      const body = toErrorBody(err);
      pushToast({ level: 'warning', message: body.message });
    }
  };

  if (conflicts.length === 0) {
    return (
      <EmptyState
        title={strings.conflict.emptyTitle}
        hint={
          operation === 'idle'
            ? strings.conflict.emptyHintIdle
            : strings.conflict.emptyHintActive
        }
      />
    );
  }

  return (
    <section className="gc-conflicts" aria-label={strings.conflict.panelAria}>
      <h3 className="gc-conflicts__title">
        <span className="gc-conflicts__badge" aria-hidden="true">
          U
        </span>
        {strings.conflict.unresolvedCount(formatCount(conflicts.length, language))}
      </h3>
      <p className="gc-conflicts__hint">
        {strings.conflict.hint}
      </p>
      <ul className="gc-conflicts__list">
        {conflicts.map((entry) => {
          const safePath = sanitizeGitText(entry.path);
          return (
            <li key={entry.path} className="gc-conflicts__item">
              <span className="gc-conflicts__path" title={safePath}>
                {safePath}
              </span>
              <span className="gc-conflicts__code">{conflictLabel(entry.code, language)}</span>
              <span className="gc-conflicts__actions">
                <button
                  type="button"
                  className="gc-button gc-button--action"
                  aria-label={conflictActionLabel(strings.conflict.actionResolveIn, entry.path, language)}
                  title={strings.conflict.resolveTitle}
                  onClick={() => void openMergeEditor(entry.path)}
                >
                  {strings.conflict.resolveButton}
                </button>
                <button
                  type="button"
                  className="gc-button gc-button--quiet"
                  aria-label={conflictActionLabel(strings.conflict.actionMarkResolved, entry.path, language)}
                  title={strings.conflict.markResolvedTitle}
                  disabled={busy}
                  onClick={() => void stage([entry.path])}
                >
                  {strings.conflict.markResolvedButton}
                </button>
              </span>
            </li>
          );
        })}
      </ul>
      <div className="gc-conflicts__footer">
        {/*
          Tier deliberately NOT `--primary`: this button is permanently disabled and
          the live `Lanjutkan merge` lives in `OperationBanner` above. Two loud buttons
          with the same word, one of which never works, is worse than one — so this one
          keeps the neutral tier and exists only to state the gate that is blocking it.
        */}
        <button
          type="button"
          className="gc-button"
          disabled
          aria-describedby={blockedId}
          title={strings.conflict.continueLockedTitle}
        >
          {strings.conflict.continueMerge}
        </button>
        <button
          type="button"
          className="gc-button"
          title={strings.conflict.abortMergeTitle}
          onClick={() => void runAction({ action: 'merge-abort' })}
        >
          {strings.conflict.abortMerge}
        </button>
        <span className="gc-help-text" id={blockedId}>
          {strings.conflict.resolveAllFirst}
        </span>
      </div>
    </section>
  );
}
