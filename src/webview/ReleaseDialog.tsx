/**
 * Create tag and publish GitHub release dialog (P28, frames 10 and 99).
 *
 * Sidebar-friendly modal overlay: tag name with semver suggestion hint, target
 * picker (branches + current HEAD listbox or typed commit hash), title, plain
 * markdown notes textarea with GitHub note generation, annotated/prerelease
 * switches, explicit command preview, live step progress, and Tag only / Publish
 * release actions. Never includes release asset upload (D-P28-2).
 */
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent,
} from 'react';
import {
  validateBranchName,
  validateHash,
  validateRemoteName,
  validateTagMessage,
  validateTagName,
} from '../validation';
import {
  canPublish,
  previousTag,
  releaseCommands,
  suggestNextTag,
} from '../releasePlan';
import { sanitizeGitText, shortHash } from './format';
import {
  useBranchesStore,
  useGitHubStore,
  useReleaseStore,
  useRepoStore,
  type ReleaseStepStatus,
} from './store';
import { Icon, InfoBanner, type IconName } from './ui';
import { useDialogFocusTrap } from './useDialogFocusTrap';
import { useT } from './useT';

interface TargetOption {
  value: string;
  label: string;
  meta: string;
}

function stepIcon(status: ReleaseStepStatus): IconName {
  if (status === 'done') return 'check';
  if (status === 'failed') return 'error';
  if (status === 'active') return 'status-running';
  if (status === 'skipped') return 'status-skipped';
  return 'status-queued';
}

export function ReleaseDialog(): JSX.Element | null {
  const strings = useT();
  const open = useReleaseStore((s) => s.open);
  const form = useReleaseStore((s) => s.form);
  const generating = useReleaseStore((s) => s.generating);
  const notesError = useReleaseStore((s) => s.notesError);
  const phase = useReleaseStore((s) => s.phase);
  const steps = useReleaseStore((s) => s.steps);
  const error = useReleaseStore((s) => s.error);
  const failedStep = useReleaseStore((s) => s.failedStep);
  const createdUrl = useReleaseStore((s) => s.createdUrl);
  const mode = useReleaseStore((s) => s.mode);
  const canFetch = useReleaseStore((s) => s.canFetch);
  const fetching = useReleaseStore((s) => s.fetching);
  const closeDialog = useReleaseStore((s) => s.closeDialog);
  const setField = useReleaseStore((s) => s.setField);
  const generateNotes = useReleaseStore((s) => s.generateNotes);
  const fetchRemote = useReleaseStore((s) => s.fetchRemote);
  const submit = useReleaseStore((s) => s.submit);

  const refs = useBranchesStore((s) => s.refs);
  const status = useRepoStore((s) => s.status);
  const graph = useRepoStore((s) => s.graph);
  const auth = useGitHubStore((s) => s.auth);
  const linkage = useGitHubStore((s) => s.linkage);
  const openUrl = useGitHubStore((s) => s.openUrl);

  const [targetMenuOpen, setTargetMenuOpen] = useState(false);
  const [activeOptionIdx, setActiveOptionIdx] = useState(0);

  const tagInputRef = useRef<HTMLInputElement>(null);
  const targetInputRef = useRef<HTMLInputElement>(null);
  const targetWrapRef = useRef<HTMLDivElement>(null);
  const listboxRef = useRef<HTMLDivElement>(null);
  const returnFocus = useRef<Element | null>(null);

  const titleId = useId();
  const introId = useId();
  const tagInputId = useId();
  const tagHintId = useId();
  const tagErrId = useId();
  const targetInputId = useId();
  const targetListboxId = useId();
  const titleInputId = useId();
  const notesInputId = useId();

  const busy = phase === 'tagging' || phase === 'pushing' || phase === 'releasing' || fetching;
  const locked = busy || phase === 'done';

  const handleClose = (): void => {
    if (busy) return;
    setTargetMenuOpen(false);
    closeDialog();
  };

  const { dialogRef, onKeyDown } = useDialogFocusTrap(handleClose);

  useEffect(() => {
    if (!open) return undefined;
    returnFocus.current = document.activeElement;
    tagInputRef.current?.focus();
    return () => {
      const previous = returnFocus.current;
      if (previous instanceof HTMLElement) previous.focus();
    };
  }, [open]);

  useEffect(() => {
    if (!targetMenuOpen) return undefined;
    const onOutside = (event: MouseEvent): void => {
      if (targetWrapRef.current !== null && !targetWrapRef.current.contains(event.target as Node)) {
        setTargetMenuOpen(false);
      }
    };
    window.addEventListener('mousedown', onOutside);
    return () => window.removeEventListener('mousedown', onOutside);
  }, [targetMenuOpen]);

  const existingTags = useMemo(
    () => refs.filter((r) => r.kind === 'tag').map((r) => r.shortName),
    [refs],
  );

  const recentSubjects = useMemo(() => {
    const nodes = graph?.nodes ?? [];
    const subjects: string[] = [];
    for (const node of nodes) {
      if (node.refNames.some((r) => /^tag:\s*v?\d+\.\d+\.\d+$/.test(r))) break;
      subjects.push(node.subject);
      if (subjects.length >= 50) break;
    }
    return subjects;
  }, [graph]);

  const suggestion = useMemo(
    () => suggestNextTag(existingTags, recentSubjects),
    [existingTags, recentSubjects],
  );

  const prevForSuggestion = useMemo(
    () => (suggestion !== null ? previousTag(existingTags, suggestion.name) : null),
    [existingTags, suggestion],
  );

  const targetOptions = useMemo<TargetOption[]>(() => {
    const opts: TargetOption[] = refs
      .filter((r) => r.kind === 'local')
      .map((r) => ({
        value: r.shortName,
        label: sanitizeGitText(r.shortName),
        meta: shortHash(r.objectName),
      }));
    if (status?.head) {
      opts.push({
        value: status.head,
        label: `${strings.release.currentHead} (${shortHash(status.head)})`,
        meta: shortHash(status.head),
      });
    }
    return opts;
  }, [refs, status?.head, strings.release.currentHead]);

  if (!open) return null;

  const owner = linkage?.owner ?? '';
  const repo = linkage?.repo ?? '';
  const connected =
    auth?.connected === true &&
    linkage?.available === true &&
    owner.length > 0 &&
    repo.length > 0;

  const tagValid = validateTagName(form.tag);
  const targetValid = validateHash(form.target) || validateBranchName(form.target);
  const isDuplicate = steps.tag !== 'done' && existingTags.includes(form.tag);
  const tagProblem =
    form.tag.length > 0 && !tagValid
      ? strings.release.tagNameInvalid
      : isDuplicate
        ? strings.release.tagExists(form.tag)
        : null;

  const remoteTrimmed = form.remote.trim();
  const remoteValidOrEmpty = remoteTrimmed.length === 0 || validateRemoteName(remoteTrimmed);
  const canTagOnly =
    tagValid &&
    targetValid &&
    !isDuplicate &&
    (!form.annotated || validateTagMessage(form.title.trim() || form.tag)) &&
    remoteValidOrEmpty &&
    !busy &&
    phase !== 'done';
  const canPublishRelease =
    canPublish(form, connected) && !isDuplicate && !busy && phase !== 'done';

  const prevForNotes = tagValid ? previousTag(existingTags, form.tag) : null;
  const commands = releaseCommands(
    form,
    owner || 'owner',
    repo || 'repo',
    connected ? 'release' : 'tag',
  );

  const tagDescribedBy =
    [suggestion !== null ? tagHintId : '', tagProblem !== null ? tagErrId : '']
      .filter((id) => id.length > 0)
      .join(' ') || undefined;

  const selectTarget = (value: string): void => {
    setField('target', value);
    setTargetMenuOpen(false);
    targetInputRef.current?.focus();
  };

  const openTargetList = (): void => {
    if (locked || targetOptions.length === 0) return;
    const currentIdx = targetOptions.findIndex((opt) => opt.value === form.target);
    setActiveOptionIdx(currentIdx >= 0 ? currentIdx : 0);
    setTargetMenuOpen(true);
    setTimeout(() => listboxRef.current?.focus(), 0);
  };

  const onTargetInputKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      openTargetList();
    } else if (event.key === 'Escape' && targetMenuOpen) {
      event.preventDefault();
      event.stopPropagation();
      setTargetMenuOpen(false);
    }
  };

  const onListboxKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const count = targetOptions.length;
    if (count === 0) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActiveOptionIdx((idx) => (idx + 1) % count);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveOptionIdx((idx) => (idx - 1 + count) % count);
    } else if (event.key === 'Home') {
      event.preventDefault();
      setActiveOptionIdx(0);
    } else if (event.key === 'End') {
      event.preventDefault();
      setActiveOptionIdx(count - 1);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const chosen = targetOptions[activeOptionIdx];
      if (chosen !== undefined) selectTarget(chosen.value);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      setTargetMenuOpen(false);
      targetInputRef.current?.focus();
    }
  };

  const bumpWord =
    suggestion === null
      ? ''
      : suggestion.bump === 'major'
        ? strings.release.bumpMajor
        : suggestion.bump === 'minor'
          ? strings.release.bumpMinor
          : strings.release.bumpPatch;

  const failedStepLabel =
    failedStep === 'tag'
      ? strings.release.stepTagging
      : failedStep === 'push'
        ? strings.release.stepPushing
        : strings.release.stepReleasing;

  const progressSteps: Array<{ key: 'tag' | 'push' | 'release'; label: string; status: ReleaseStepStatus }> = [
    { key: 'tag', label: strings.release.stepTagging, status: steps.tag },
    { key: 'push', label: strings.release.stepPushing, status: steps.push },
    ...(mode === 'tag'
      ? []
      : [{ key: 'release' as const, label: strings.release.stepReleasing, status: steps.release }]),
  ];

  return (
    <div className="gc-modal-backdrop">
      <div
        className="gc-modal gc-modal--start-work gc-release"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={introId}
        ref={dialogRef}
        onKeyDown={onKeyDown}
      >
        <header className="gc-start-work__header">
          <span className="gc-start-work__badge" aria-hidden="true">
            <Icon name="tag" />
          </span>
          <div className="gc-start-work__titles">
            <h2 className="gc-modal__title" id={titleId}>
              {strings.release.dialogTitle}
            </h2>
            <p className="gc-start-work__subtitle" id={introId}>
              {strings.release.dialogIntro(
                sanitizeGitText(form.tag || '...'),
                sanitizeGitText(form.target || '...'),
              )}
            </p>
          </div>
          <button
            type="button"
            className="gc-icon-button"
            aria-label={strings.release.cancel}
            title={strings.release.cancel}
            disabled={busy}
            onClick={handleClose}
          >
            <Icon name="close" />
          </button>
        </header>

        <div className="gc-start-work__body gc-release__body">
          <div className="gc-field">
            <label htmlFor={tagInputId} className="gc-field__label">
              {strings.release.fieldTag}
            </label>
            <input
              ref={tagInputRef}
              id={tagInputId}
              type="text"
              value={form.tag}
              disabled={locked}
              aria-invalid={tagProblem !== null ? 'true' : undefined}
              aria-describedby={tagDescribedBy}
              onChange={(event) => setField('tag', event.target.value)}
            />
            {suggestion !== null && (
              <p className="gc-field__hint" id={tagHintId}>
                {prevForSuggestion !== null
                  ? strings.release.suggestionHint(prevForSuggestion, bumpWord, suggestion.reason)
                  : sanitizeGitText(suggestion.reason)}
              </p>
            )}
            {tagProblem !== null && (
              <p className="gc-field__error" id={tagErrId} role="alert">
                <span aria-hidden="true">!</span>
                <span>{tagProblem}</span>
              </p>
            )}
          </div>

          <div className="gc-field" ref={targetWrapRef}>
            <label htmlFor={targetInputId} className="gc-field__label">
              {strings.release.fieldTarget}
            </label>
            <div className="gc-release__target-row">
              <input
                ref={targetInputRef}
                id={targetInputId}
                type="text"
                value={form.target}
                disabled={locked}
                aria-invalid={form.target.length > 0 && !targetValid ? 'true' : undefined}
                onChange={(event) => setField('target', event.target.value)}
                onKeyDown={onTargetInputKeyDown}
              />
              <button
                type="button"
                className="gc-button gc-release__target-toggle"
                aria-label={strings.release.fieldTarget}
                aria-expanded={targetMenuOpen}
                aria-controls={targetListboxId}
                disabled={locked || targetOptions.length === 0}
                onClick={() => {
                  if (targetMenuOpen) setTargetMenuOpen(false);
                  else openTargetList();
                }}
              >
                <Icon name="chevron-down" />
              </button>
            </div>
            {targetMenuOpen && (
              <div
                id={targetListboxId}
                ref={listboxRef}
                role="listbox"
                aria-label={strings.release.fieldTarget}
                aria-activedescendant={
                  targetOptions[activeOptionIdx] !== undefined
                    ? `${targetListboxId}-opt-${activeOptionIdx}`
                    : undefined
                }
                tabIndex={0}
                className="gc-release__listbox"
                onKeyDown={onListboxKeyDown}
              >
                {targetOptions.map((opt, idx) => (
                  <div
                    key={opt.value}
                    id={`${targetListboxId}-opt-${idx}`}
                    role="option"
                    aria-selected={form.target === opt.value}
                    className={`gc-release__option${idx === activeOptionIdx ? ' gc-release__option--active' : ''}`}
                    onClick={() => selectTarget(opt.value)}
                  >
                    <span className="gc-release__option-label">{opt.label}</span>
                    <span className="gc-release__option-meta">{opt.meta}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="gc-field">
            <label htmlFor={titleInputId} className="gc-field__label">
              {strings.release.fieldTitle}
            </label>
            <input
              id={titleInputId}
              type="text"
              value={form.title}
              maxLength={256}
              disabled={locked}
              onChange={(event) => setField('title', event.target.value)}
            />
          </div>

          <div className="gc-field">
            <div className="gc-release__notes-head">
              <label htmlFor={notesInputId} className="gc-field__label">
                {strings.release.fieldNotes}
              </label>
              <span className="gc-release__notes-source">{strings.release.notesSource}</span>
              <button
                type="button"
                className="gc-button gc-button--quiet gc-release__regen"
                disabled={!connected || !tagValid || generating || locked}
                onClick={() => void generateNotes(owner, repo, prevForNotes ?? undefined)}
              >
                {generating ? strings.release.generatingNotes : strings.release.regenerateNotes}
              </button>
            </div>
            <textarea
              id={notesInputId}
              className="gc-release__notes"
              value={form.notes}
              maxLength={125000}
              disabled={locked}
              onChange={(event) => setField('notes', event.target.value)}
            />
            {notesError !== null && (
              <p className="gc-field__error" role="alert">
                <span aria-hidden="true">!</span>
                <span>{sanitizeGitText(notesError)}</span>
              </p>
            )}
          </div>

          <div className="gc-release__switches">
            <label className="gc-release__switch">
              <input
                type="checkbox"
                role="switch"
                aria-checked={form.annotated}
                checked={form.annotated}
                disabled={locked}
                onChange={(event) => setField('annotated', event.target.checked)}
              />
              <span>{strings.release.toggleAnnotated}</span>
            </label>
            <label className="gc-release__switch">
              <input
                type="checkbox"
                role="switch"
                aria-checked={form.prerelease}
                checked={form.prerelease}
                disabled={locked}
                onChange={(event) => setField('prerelease', event.target.checked)}
              />
              <span>{strings.release.togglePrerelease}</span>
            </label>
          </div>

          <div className="gc-release__preview">
            <span className="gc-start-work__command-label">{strings.release.whatWillRun}</span>
            <pre className="gc-release__commands" aria-label={strings.release.whatWillRun}>
              {commands.join('\n')}
            </pre>
          </div>

          {!connected && (
            <InfoBanner tone="info" glyph="info">
              {strings.release.notConnected}
            </InfoBanner>
          )}

          {phase !== 'idle' && (
            <div className="gc-release__progress" aria-live="polite">
              <ol className="gc-release__steps">
                {progressSteps.map((step) => (
                  <li
                    key={step.key}
                    className={`gc-release__step gc-release__step--${step.status}`}
                    aria-current={step.status === 'active' ? 'step' : undefined}
                  >
                    <Icon name={stepIcon(step.status)} />
                    <span>{step.label}</span>
                  </li>
                ))}
              </ol>
              {phase === 'failed' && error !== null && (
                <div className="gc-release__error-row">
                  <p className="gc-field__error" role="alert">
                    <span aria-hidden="true">!</span>
                    <span>
                      {strings.release.partialFailure(failedStepLabel)} {sanitizeGitText(error)}
                    </span>
                  </p>
                  {canFetch && (
                    <button
                      type="button"
                      className="gc-button gc-release__fetch"
                      disabled={fetching}
                      onClick={() => void fetchRemote()}
                    >
                      <Icon name="fetch" />
                      {strings.explorerSync.fetchButton}
                    </button>
                  )}
                </div>
              )}
              {phase === 'done' && (
                <div className="gc-release__done">
                  <span>
                    {mode === 'release'
                      ? strings.release.doneRelease(sanitizeGitText(form.tag))
                      : strings.release.doneTag(sanitizeGitText(form.tag))}
                  </span>
                  {createdUrl !== null && (
                    <button
                      type="button"
                      className="gc-button"
                      onClick={() => void openUrl(createdUrl)}
                    >
                      <Icon name="external" />
                      {strings.release.viewOnGitHub}
                    </button>
                  )}
                </div>
              )}
            </div>
          )}

          <div className="gc-modal__actions gc-release__actions">
            <button
              type="button"
              className="gc-button"
              disabled={busy}
              onClick={handleClose}
            >
              {phase === 'done' ? strings.release.close : strings.release.cancel}
            </button>
            <button
              type="button"
              className="gc-button gc-button--action"
              disabled={!canTagOnly}
              onClick={() => void submit('tag')}
            >
              {strings.release.tagOnly}
            </button>
            <button
              type="button"
              className="gc-button gc-button--primary"
              disabled={!canPublishRelease}
              onClick={() => void submit('release', owner, repo)}
            >
              {phase === 'failed' && failedStep === 'release'
                ? strings.release.retryRelease
                : strings.release.publishRelease}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
