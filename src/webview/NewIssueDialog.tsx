/**
 * New issue dialog (P26, frame 101).
 *
 * 340 px sidebar modal: Title, Description, Labels (chips + repository label
 * picker), read-only command preview (`POST /repos/{owner}/{repo}/issues`),
 * Cancel, and Create issue. Acts only through `useIssuesStore`; untrusted label
 * names and repository slugs pass through `sanitizeGitText`.
 */
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type JSX,
  type KeyboardEvent,
} from 'react';
import { formatCount, sanitizeGitText } from './format';
import { canCreateIssue, issueCommand, labelChipTone } from './issueFilters';
import { nextIndex } from './listNav';
import { useIssuesStore, useSettingsStore } from './store';
import { Icon } from './ui';
import { useDialogFocusTrap } from './useDialogFocusTrap';
import { useT } from './useT';
import { validateIssueTitle } from '../validation';
import type { IssueLabel } from '../messages';

const TITLE_MAX = 256;
const BODY_MAX = 65_536;
const LABELS_MAX = 10;

export interface NewIssueDialogProps {
  owner: string;
  repo: string;
  onCancel(): void;
  onCreated(number: number): void;
}

export function NewIssueDialog({
  owner,
  repo,
  onCancel,
  onCreated,
}: NewIssueDialogProps): JSX.Element {
  const strings = useT();
  const language = useSettingsStore((s) => s.language);
  const repoLabels = useIssuesStore((s) => s.labels);
  const loadLabels = useIssuesStore((s) => s.loadLabels);
  const create = useIssuesStore((s) => s.create);
  const creating = useIssuesStore((s) => s.creating);

  const [title, setTitle] = useState('');
  const [titleTouched, setTitleTouched] = useState(false);
  const [body, setBody] = useState('');
  const [selectedLabels, setSelectedLabels] = useState<string[]>([]);
  const [limitReached, setLimitReached] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [activeOption, setActiveOption] = useState(0);

  const handleCancel = (): void => {
    if (creating) return;
    onCancel();
  };

  const { dialogRef, onKeyDown } = useDialogFocusTrap(handleCancel);
  const titleInputRef = useRef<HTMLInputElement | null>(null);
  const addButtonRef = useRef<HTMLButtonElement | null>(null);
  const optionRefs = useRef<Array<HTMLDivElement | null>>([]);
  const returnFocus = useRef<Element | null>(null);

  const titleId = useId();
  const introId = useId();
  const titleProblemId = useId();
  const descLimitId = useId();
  const labelHintId = useId();
  const commandLabelId = useId();

  useEffect(() => {
    returnFocus.current = document.activeElement;
    titleInputRef.current?.focus();
    void loadLabels();
    return () => {
      const previous = returnFocus.current;
      if (previous instanceof HTMLElement) previous.focus();
    };
  }, [loadLabels]);

  useEffect(() => {
    if (!pickerOpen || repoLabels.length === 0) return;
    const idx = Math.min(activeOption, repoLabels.length - 1);
    optionRefs.current[idx]?.focus();
  }, [pickerOpen, repoLabels.length, activeOption]);

  const labelByName = useMemo(() => {
    const map = new Map<string, IssueLabel>();
    for (const item of repoLabels) map.set(item.name, item);
    return map;
  }, [repoLabels]);

  const slug = `${sanitizeGitText(owner)}/${sanitizeGitText(repo)}`;
  const command = issueCommand(owner, repo);
  const titleValid = validateIssueTitle(title);
  const showTitleError = titleTouched && !titleValid;
  const canSubmit = canCreateIssue({ title, body, labels: selectedLabels }) && !creating;

  const toggleLabel = (name: string): void => {
    setSelectedLabels((prev) => {
      if (prev.includes(name)) {
        setLimitReached(false);
        return prev.filter((item) => item !== name);
      }
      if (prev.length >= LABELS_MAX) {
        setLimitReached(true);
        return prev;
      }
      setLimitReached(false);
      return [...prev, name];
    });
  };

  const onPickerKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      setPickerOpen(false);
      addButtonRef.current?.focus();
      return;
    }
    if (event.key === ' ' || event.key === 'Enter') {
      event.preventDefault();
      const target = repoLabels[activeOption];
      if (target !== undefined) toggleLabel(target.name);
      return;
    }
    const next = nextIndex(event.key, activeOption, repoLabels.length);
    if (next >= 0) {
      event.preventDefault();
      setActiveOption(next);
      optionRefs.current[next]?.focus();
    }
  };

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setTitleTouched(true);
    if (!canSubmit) return;
    const created = await create({
      title: title.trim(),
      body,
      labels: selectedLabels,
    });
    if (created !== null) {
      onCreated(created.number);
    }
  };

  return (
    <div className="gc-modal-backdrop">
      <div
        className="gc-modal gc-modal--start-work gc-modal--new-issue"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={introId}
        ref={dialogRef}
        onKeyDown={onKeyDown}
      >
        <header className="gc-start-work__header">
          <span className="gc-start-work__badge" aria-hidden="true">
            <Icon name="issue" />
          </span>
          <div className="gc-start-work__titles">
            <h2 className="gc-modal__title" id={titleId}>
              {strings.issueWrite.dialogTitle}
            </h2>
            <p className="gc-start-work__subtitle" id={introId}>
              {strings.issueWrite.dialogIntro(slug)}
            </p>
          </div>
          <button
            type="button"
            className="gc-icon-button"
            aria-label={strings.issueWrite.cancel}
            title={strings.issueWrite.cancel}
            disabled={creating}
            onClick={handleCancel}
          >
            <Icon name="close" />
          </button>
        </header>

        <form className="gc-start-work__body" onSubmit={(e) => void submit(e)}>
          <label className="gc-field">
            <span className="gc-field__label">{strings.issueWrite.fieldTitle}</span>
            <input
              ref={titleInputRef}
              type="text"
              value={title}
              maxLength={TITLE_MAX}
              disabled={creating}
              aria-label={strings.issueWrite.fieldTitle}
              aria-invalid={showTitleError}
              aria-describedby={showTitleError ? titleProblemId : undefined}
              onChange={(event) => {
                setTitle(event.target.value);
                setTitleTouched(true);
              }}
            />
          </label>

          {showTitleError && (
            <p className="gc-field__error" id={titleProblemId} role="alert">
              <span aria-hidden="true">!</span>
              <span>{strings.issueWrite.titleRequired}</span>
            </p>
          )}

          <label className="gc-field">
            <span className="gc-field__label">{strings.issueWrite.fieldDescription}</span>
            <textarea
              rows={4}
              value={body}
              maxLength={BODY_MAX}
              disabled={creating}
              placeholder={strings.issueWrite.descriptionPlaceholder}
              aria-label={strings.issueWrite.fieldDescription}
              aria-describedby={descLimitId}
              onChange={(event) => setBody(event.target.value)}
            />
          </label>
          <span className="gc-help-text" id={descLimitId}>
            {formatCount(body.length, language)} / {formatCount(BODY_MAX, language)}
          </span>

          <div className="gc-field">
            <span className="gc-field__label">{strings.issueWrite.fieldLabels}</span>
            <div className="gc-issues__label-chips">
              {selectedLabels.map((name) => {
                const item = labelByName.get(name);
                const tone = labelChipTone(item ?? {});
                const cleanName = sanitizeGitText(name);
                return (
                  <span
                    key={name}
                    className={`gc-issues__label gc-issues__label--${tone} gc-issues__label--removable`}
                  >
                    <span>{cleanName}</span>
                    <button
                      type="button"
                      className="gc-issues__label-remove"
                      aria-label={`Remove label ${cleanName}`}
                      title={`Remove label ${cleanName}`}
                      disabled={creating}
                      onClick={() => toggleLabel(name)}
                    >
                      <Icon name="close" />
                    </button>
                  </span>
                );
              })}
              <button
                ref={addButtonRef}
                type="button"
                className="gc-button gc-button--quiet gc-issues__label-add"
                aria-expanded={pickerOpen}
                aria-haspopup="listbox"
                disabled={creating}
                onClick={() => setPickerOpen((open) => !open)}
              >
                {strings.issueWrite.addLabel}
              </button>
            </div>

            {(limitReached || selectedLabels.length >= LABELS_MAX) && (
              <span className="gc-help-text" id={labelHintId} role="status">
                {strings.issueWrite.tooManyLabels}
              </span>
            )}

            {pickerOpen && (
              repoLabels.length === 0 ? (
                <div className="gc-issues__no-labels" role="status">
                  {strings.issueWrite.noLabels}
                </div>
              ) : (
                <div
                  className="gc-issues__label-picker"
                  role="listbox"
                  aria-multiselectable="true"
                  aria-label={strings.issueWrite.fieldLabels}
                  onKeyDown={onPickerKeyDown}
                >
                  {repoLabels.map((item, idx) => {
                    const selected = selectedLabels.includes(item.name);
                    const tone = labelChipTone(item);
                    const cleanName = sanitizeGitText(item.name);
                    return (
                      <div
                        key={item.name}
                        ref={(el) => {
                          optionRefs.current[idx] = el;
                        }}
                        role="option"
                        aria-selected={selected}
                        tabIndex={idx === activeOption ? 0 : -1}
                        className="gc-issues__label-option"
                        onClick={() => {
                          setActiveOption(idx);
                          toggleLabel(item.name);
                        }}
                      >
                        <span className="gc-issues__label-check" aria-hidden="true">
                          {selected ? <Icon name="check" /> : null}
                        </span>
                        <span className={`gc-issues__label gc-issues__label--${tone}`}>
                          {cleanName}
                        </span>
                      </div>
                    );
                  })}
                </div>
              )
            )}
          </div>

          <div className="gc-start-work__command">
            <span className="gc-start-work__command-label" id={commandLabelId}>
              {strings.issueWrite.commandHeading}
            </span>
            <code aria-describedby={commandLabelId}>{command}</code>
          </div>

          <div className="gc-modal__actions">
            <button
              type="button"
              className="gc-button"
              disabled={creating}
              onClick={handleCancel}
            >
              {strings.issueWrite.cancel}
            </button>
            <button
              type="submit"
              className="gc-button gc-button--primary"
              disabled={!canSubmit}
            >
              <Icon name="add" />
              {strings.issueWrite.createIssue}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
