/**
 * Create pull request dialog (P22, frame 07).
 *
 * One form, two hosts. The sidebar renders it in place of the list, the Explorer
 * renders it as a modal over the view; only the wrapper and the width class change,
 * so the two paths cannot drift apart.
 *
 * The dialog decides nothing. `usePrDraftStore` holds the prepare result, the edits,
 * the idempotency key, and the submit that already carries the host guard's
 * confirmation. This file draws that state and previews the two calls that will run.
 * It never opens a second modal: a guard verdict has no stage to land on here.
 */
import { useEffect, useId, useLayoutEffect, useRef, useState, type FormEvent, type JSX } from 'react';
import {
  BODY_MAX,
  TITLE_MAX,
  normalizeLabels,
  normalizeLinkedIssue,
  normalizeReviewers,
  validatePullRequestInput,
} from '../pullRequestDraft';
import { apiCommandOf, gitCommandOf, sanitizeGitText } from './format';
import { useGitHubStore, usePrDraftStore } from './store';
import { useDialogFocusTrap } from './useDialogFocusTrap';
import { useT } from './useT';
import { Icon, InfoBanner } from './ui';

function BranchPickerPopover({
  label,
  value,
  options,
  disabled,
  filterPlaceholder,
  emptyLabel,
  onChange,
}: {
  label: string;
  value: string;
  options: readonly string[];
  disabled: boolean;
  filterPlaceholder: string;
  emptyLabel: string;
  onChange: (branch: string) => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [placed, setPlaced] = useState({ x: 0, y: 0, width: 220 });
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listId = useId();

  useLayoutEffect(() => {
    if (!open) return;
    const trigger = triggerRef.current;
    const popover = popoverRef.current;
    if (trigger === null || popover === null) return;
    const anchor = trigger.getBoundingClientRect();
    const box = popover.getBoundingClientRect();
    const margin = 8;
    const width = Math.max(220, Math.min(300, Math.max(anchor.width, box.width)));
    const x = Math.max(margin, Math.min(anchor.left, window.innerWidth - width - margin));
    const y = Math.max(margin, Math.min(anchor.bottom + 4, window.innerHeight - box.height - margin));
    setPlaced({ x, y, width });
    searchRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target as Node;
      if (popoverRef.current?.contains(target) === true) return;
      if (triggerRef.current?.contains(target) === true) return;
      setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => document.removeEventListener('pointerdown', onPointerDown, true);
  }, [open]);

  const q = query.trim().toLowerCase();
  const filtered = q.length === 0 ? options : options.filter((o) => o.toLowerCase().includes(q));

  return (
    <div className="gc-field">
      <span className="gc-field__label">{label}</span>
      <button
        ref={triggerRef}
        type="button"
        className="gc-toolbar__branch-select gc-popover-trigger"
        disabled={disabled}
        aria-label={`${label}: ${sanitizeGitText(value)}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        onClick={() => {
          setOpen((prev) => !prev);
          setQuery('');
        }}
      >
        <span className="gc-popover-trigger__icon" aria-hidden="true">
          <Icon name="git-branch" />
        </span>
        <span className="gc-popover-trigger__label">{sanitizeGitText(value)}</span>
        <span className="gc-popover-trigger__chevron" aria-hidden="true">
          <Icon name="chevron-down" />
        </span>
      </button>
      {open && (
        <div
          id={listId}
          ref={popoverRef}
          className="gc-menu gc-branch-popover"
          role="dialog"
          aria-label={label}
          style={{ left: `${placed.x}px`, top: `${placed.y}px`, width: `${placed.width}px` }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault();
              setOpen(false);
              triggerRef.current?.focus();
            }
          }}
        >
          <div className="gc-branch-popover__search">
            <Icon name="search" />
            <input
              ref={searchRef}
              type="search"
              className="gc-branch-popover__input"
              value={query}
              placeholder={filterPlaceholder}
              aria-label={filterPlaceholder}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <div className="gc-branch-popover__list" role="listbox" aria-label={label}>
            {filtered.map((name) => {
              const selected = name === value;
              return (
                <button
                  key={name}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  className={
                    selected
                      ? 'gc-menu__item gc-branch-popover__option gc-branch-popover__option--selected'
                      : 'gc-menu__item gc-branch-popover__option'
                  }
                  onClick={() => {
                    onChange(name);
                    setOpen(false);
                    setQuery('');
                  }}
                >
                  <span className="gc-branch-popover__check" aria-hidden="true">
                    {selected && <Icon name="check" />}
                  </span>
                  <span className="gc-menu__icon" aria-hidden="true">
                    <Icon name="git-branch" />
                  </span>
                  <span className="gc-branch-popover__name">{sanitizeGitText(name)}</span>
                </button>
              );
            })}
            {filtered.length === 0 && <p className="gc-branch-popover__empty">{emptyLabel}</p>}
          </div>
        </div>
      )}
    </div>
  );
}

export interface CreatePullRequestProps {
  variant: 'sidebar' | 'modal';
  onCancel(): void;
  /** Called once with the new number; the view owns the toast and the reload. */
  onCreated(number: number): void;
}

export function CreatePullRequest({
  variant,
  onCancel,
  onCreated,
}: CreatePullRequestProps): JSX.Element {
  const strings = useT();
  const {
    status,
    head,
    base,
    bases,
    heads,
    title,
    body,
    draft,
    reviewers,
    labels,
    linkedIssue,
    onRemote,
    ahead,
    files,
    template,
    existing,
    connected,
    canWrite,
    collaboratorsAvailable,
    created,
    setField,
    setDraft,
    addReviewer,
    removeReviewer,
    addLabel,
    removeLabel,
    setLinkedIssue,
    submit,
    close,
  } = usePrDraftStore();
  const linkage = useGitHubStore((s) => s.linkage);
  const openUrl = useGitHubStore((s) => s.openUrl);
  const connect = useGitHubStore((s) => s.connect);

  const loading = status === 'loading';
  const busy = status === 'publishing' || status === 'creating';
  const exists = status === 'exists';
  const locked = busy || loading;

  const titleId = useId();
  const summaryId = useId();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const returnFocus = useRef<Element | null>(null);
  /** The half-typed reviewer. Local, because a rejected login leaves no trace. */
  const [reviewerText, setReviewerText] = useState('');
  /** The half-typed label, same contract: a dropped one leaves no trace. */
  const [labelText, setLabelText] = useState('');
  /** The issue field's raw text, so a half-typed `#` is not thrown away. */
  const [issueText, setIssueText] = useState('');

  const cancel = (): void => {
    // Escape and the close button are the same door: neither may fire mid-flight.
    if (busy) return;
    close();
    onCancel();
  };

  const { dialogRef, onKeyDown } = useDialogFocusTrap(cancel);

  useEffect(() => {
    returnFocus.current = document.activeElement;
    return () => {
      const previous = returnFocus.current;
      if (previous instanceof HTMLElement) previous.focus();
    };
  }, []);

  // The title is disabled while the prepare is in flight, so focus waits for it.
  useEffect(() => {
    if (loading) return;
    inputRef.current?.focus();
  }, [loading]);

  useEffect(() => {
    if (created === null) return;
    close();
    onCreated(created.number);
  }, [created, close, onCreated]);

  // `normalizeReviewers` is the same fold the store applies on add, so a login it
  // would drop is dropped here too, silently: the field just stays empty.
  const commitReviewer = (): void => {
    const next = normalizeReviewers([reviewerText]);
    const login = next[0];
    if (login !== undefined) addReviewer(login);
    setReviewerText('');
  };

  // `normalizeLabels` is the same fold the store and the validator apply.
  const commitLabel = (): void => {
    const next = normalizeLabels([labelText]);
    const label = next[0];
    if (label !== undefined) addLabel(label);
    setLabelText('');
  };

  // A half-typed value is reported, not silently cleared: the field says what is
  // wrong and the create stays blocked while it does.
  const issueProblem =
    issueText.trim().length > 0 && normalizeLinkedIssue(issueText) === null;

  const valid =
    validatePullRequestInput({
      title,
      body,
      base,
      head,
      reviewers,
      ...(labels.length === 0 ? {} : { labels }),
      ...(linkedIssue === null ? {} : { linkedIssue }),
    }).ok && !issueProblem;
  const disabled = !valid || !connected || canWrite === 'no' || busy || exists;

  const primaryLabel = busy
    ? strings.createPr.creating
    : !connected
      ? strings.createPr.publishOnly
      : onRemote
        ? strings.createPr.submit
        : strings.createPr.submitPush;

  const baseOptions = bases.includes(base) ? bases : [base, ...bases].filter((n) => n.length > 0);
  const headOptions = heads.includes(head) ? heads : [head, ...heads].filter((n) => n.length > 0);

  // No head yet (prepare still running) means no line: the formatter would draw a
  // push with an empty branch name, which is not a command anyone can run.
  const pushLine =
    onRemote || head.length === 0
      ? null
      : gitCommandOf({ action: 'push', remote: 'origin', branch: head, setUpstream: true });
  const owner = linkage?.owner ?? null;
  const repo = linkage?.repo ?? null;
  const apiLine =
    owner !== null && repo !== null ? apiCommandOf('create-pull-request', owner, repo) : null;
  // A 409 after the prepare carries the number but no URL, so the link is rebuilt
  // from the linkage's own web URL. A page link, not a git or API command.
  const existingUrl =
    existing === null
      ? null
      : existing.url.length > 0
        ? existing.url
        : linkage?.webUrl == null
          ? null
          : `${linkage.webUrl.replace(/\/+$/, '')}/pull/${existing.number}`;

  const onFormSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (!disabled) void submit();
  };

  const dialog = (
    <div
      className={
        variant === 'modal'
          ? 'gc-create-pr gc-create-pr--modal'
          : 'gc-create-pr gc-create-pr--sidebar'
      }
      role="dialog"
      aria-modal={variant === 'modal' ? true : undefined}
      aria-labelledby={titleId}
      aria-describedby={summaryId}
      ref={dialogRef}
      onKeyDown={onKeyDown}
    >
      <header className="gc-create-pr__head">
        <span className="gc-create-pr__badge" aria-hidden="true">
          <Icon name="pr" />
        </span>
        <div className="gc-create-pr__titles">
          <h2 className="gc-create-pr__title" id={titleId}>
            {strings.createPr.title}
          </h2>
          <p className="gc-create-pr__summary" id={summaryId}>
            {strings.createPr.summary(String(ahead), String(files))}
          </p>
        </div>
        <button
          type="button"
          className="gc-icon-button"
          aria-label={strings.createPr.cancel}
          title={strings.createPr.cancel}
          onClick={cancel}
        >
          <Icon name="close" />
        </button>
      </header>

      <form className="gc-create-pr__body" onSubmit={onFormSubmit}>
        <div className="gc-create-pr__branches">
          <BranchPickerPopover
            label={strings.createPr.base}
            value={base}
            options={baseOptions}
            disabled={locked}
            filterPlaceholder={strings.graph.branchPopoverFilter}
            emptyLabel={strings.branches.emptyFilter}
            onChange={(val) => setField('base', val)}
          />
          <span className="gc-create-pr__arrow" aria-hidden="true">
            →
          </span>
          <BranchPickerPopover
            label={strings.createPr.compare}
            value={head}
            options={headOptions}
            disabled={locked}
            filterPlaceholder={strings.graph.branchPopoverFilter}
            emptyLabel={strings.branches.emptyFilter}
            onChange={(val) => setField('head', val)}
          />
        </div>

        <label className="gc-field">
          <span className="gc-field__label">
            <span>{strings.createPr.titleLabel}</span>
            <span
              className="gc-create-pr__counter"
              aria-live={title.length >= TITLE_MAX ? 'polite' : 'off'}
            >
              {strings.createPr.titleCount(String(title.length), String(TITLE_MAX))}
            </span>
          </span>
          <input
            ref={inputRef}
            type="text"
            value={title}
            maxLength={TITLE_MAX}
            spellCheck={false}
            autoComplete="off"
            disabled={locked}
            onChange={(event) => setField('title', event.target.value)}
          />
        </label>

        <label className="gc-field">
          <span className="gc-field__label">
            <span>{strings.createPr.body}</span>
            {/*
              Frame 07 prints the path, not the template body, which is already
              visible in the textarea. The host tries `.github/pull_request_template.md`
              first and `docs/pull_request_template.md` second, and it does not report
              which one it read, so the first path is the literal the label shows.
            */}
            <span className="gc-create-pr__template">
              {template === null
                ? strings.createPr.noTemplate
                : strings.createPr.fromTemplate('.github/pull_request_template.md')}
            </span>
          </span>
          <textarea
            value={body}
            rows={8}
            maxLength={BODY_MAX}
            spellCheck={false}
            disabled={locked}
            onChange={(event) => setField('body', event.target.value)}
          />
        </label>

        {/*
          Frame 07 (`72:62`): one metadata row, Reviewers then Labels then Linked
          issue. Each is the same shape: a named field with a chip or input.
        */}
        <div className="gc-create-pr__meta">
          <div className="gc-field gc-create-pr__reviewers">
            <span className="gc-field__label">{strings.createPr.reviewers}</span>
            <div className="gc-create-pr__chips">
              {reviewers.map((login) => {
                const name = sanitizeGitText(login);
                return (
                  <span key={login} className="gc-chip">
                    {name}
                    <button
                      type="button"
                      className="gc-icon-button gc-create-pr__chip-remove"
                      aria-label={`${name}, ${strings.createPr.reviewers}`}
                      title={`${name}, ${strings.createPr.reviewers}`}
                      disabled={locked}
                      onClick={() => removeReviewer(login)}
                    >
                      <Icon name="close" />
                    </button>
                  </span>
                );
              })}
              <label className="gc-field gc-create-pr__add">
                <span className="gc-field__label">{strings.createPr.add}</span>
                <input
                  type="text"
                  value={reviewerText}
                  maxLength={39}
                  spellCheck={false}
                  autoComplete="off"
                  disabled={locked || !collaboratorsAvailable}
                  onChange={(event) => setReviewerText(event.target.value)}
                  onKeyDown={(event) => {
                    // Enter adds and stays in the field: a reviewer list is typed in
                    // one go, and a form submit here would create the pull request.
                    if (event.key !== 'Enter') return;
                    event.preventDefault();
                    commitReviewer();
                  }}
                />
              </label>
            </div>
            {!collaboratorsAvailable && (
              <span className="gc-field__hint">{strings.createPr.reviewersUnavailable}</span>
            )}
          </div>

          <div className="gc-field gc-create-pr__labels">
            <span className="gc-field__label">{strings.createPr.labels}</span>
            <div className="gc-create-pr__chips">
              {labels.map((label) => {
                const name = sanitizeGitText(label);
                return (
                  <span key={label} className="gc-chip">
                    {name}
                    <button
                      type="button"
                      className="gc-icon-button gc-create-pr__chip-remove"
                      aria-label={`${name}, ${strings.createPr.labels}`}
                      title={`${name}, ${strings.createPr.labels}`}
                      disabled={locked}
                      onClick={() => removeLabel(label)}
                    >
                      <Icon name="close" />
                    </button>
                  </span>
                );
              })}
              <label className="gc-field gc-create-pr__add">
                <span className="gc-field__label">{strings.createPr.addLabel}</span>
                <input
                  type="text"
                  value={labelText}
                  maxLength={50}
                  spellCheck={false}
                  autoComplete="off"
                  disabled={locked}
                  onChange={(event) => setLabelText(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key !== 'Enter') return;
                    event.preventDefault();
                    commitLabel();
                  }}
                />
              </label>
            </div>
          </div>

          <label className="gc-field gc-create-pr__issue">
            <span className="gc-field__label">{strings.createPr.linkedIssue}</span>
            <input
              type="text"
              inputMode="numeric"
              value={issueText}
              maxLength={12}
              spellCheck={false}
              autoComplete="off"
              disabled={locked}
              aria-invalid={issueProblem ? true : undefined}
              onChange={(event) => {
                setIssueText(event.target.value);
                setLinkedIssue(normalizeLinkedIssue(event.target.value));
              }}
            />
            <span className="gc-field__hint">
              {issueProblem ? strings.createPr.linkedIssueInvalid : strings.createPr.linkedIssueHint}
            </span>
          </label>
        </div>

        {exists && (
          // The shared error-banner markup: `InfoBanner` carries only info and
          // warning tones, and this state must read as the failure it is.
          <div className="gc-banner gc-banner--error" role="alert">
            <span className="gc-banner__glyph" aria-hidden="true">
              <Icon name="error" />
            </span>
            <div className="gc-banner__body">
              <strong>{strings.createPr.existsTitle}</strong>
              <span>
                {strings.createPr.existsBody(
                  String(existing?.number ?? 0),
                  sanitizeGitText(head),
                  sanitizeGitText(base),
                )}
              </span>
              {existing !== null && existingUrl !== null && (
                <button
                  type="button"
                  className="gc-button gc-button--quiet"
                  onClick={() => void openUrl(existingUrl)}
                >
                  {strings.createPr.openN(String(existing.number))}
                </button>
              )}
            </div>
          </div>
        )}

        {!connected && (
          <InfoBanner tone="warning" glyph="warning">
            <strong>{strings.createPr.connectTitle}</strong>
            <span>{strings.createPr.connectBody}</span>
            <button
              type="button"
              className="gc-button gc-button--action"
              onClick={() => void connect()}
            >
              {strings.prs.signInBannerAction}
            </button>
          </InfoBanner>
        )}

        {connected && onRemote && (
          <InfoBanner tone="info" glyph="check">
            <strong>{strings.createPr.onOrigin(sanitizeGitText(head))}</strong>
            <span>{strings.createPr.onlyPr}</span>
          </InfoBanner>
        )}

        {connected && !onRemote && (
          <InfoBanner tone="info" glyph="push">
            <strong>{strings.createPr.notOnOrigin(sanitizeGitText(head))}</strong>
          </InfoBanner>
        )}

        <label className="gc-create-pr__switch">
          <input
            type="checkbox"
            role="switch"
            aria-checked={draft}
            checked={draft}
            disabled={locked}
            onChange={(event) => setDraft(event.target.checked)}
          />
          <span>{strings.createPr.draft}</span>
        </label>

        {busy && (
          <div className="gc-create-pr__progress" role="status">
            {/*
              The publish phase names the command that is running rather than a
              sentence about it: the catalog has no "published" entry, and the
              command is what the rest of this panel uses to explain a step.
            */}
            {status === 'publishing' && pushLine !== null && <code>{pushLine}</code>}
            <span>{strings.createPr.creatingOnGitHub}</span>
          </div>
        )}

        {(pushLine !== null || apiLine !== null) && (
          <div className="gc-create-pr__willrun">
            <span className="gc-create-pr__willrun-label">
              <Icon name="chevron-right" />
              <Icon name="play" />
              <span>{strings.createPr.willRun}</span>
            </span>
            <code className="gc-create-pr__commands">
              {pushLine !== null && (
                <span className="gc-create-pr__command--push">{pushLine}</span>
              )}
              {apiLine !== null && <span className="gc-create-pr__command--api">{apiLine}</span>}
            </code>
          </div>
        )}

        <footer className="gc-create-pr__footer">
          <button type="button" className="gc-button" onClick={cancel} disabled={busy}>
            {strings.createPr.cancel}
          </button>
          <div className="gc-create-pr__footer-end">
            {/*
              Frame 07 (`72:112`) draws all three unconditionally. Create draft
              forces the flag for its own submit, so one press creates a draft even
              when the switch was left off; the switch itself does not move.
            */}
            <button
              type="button"
              className="gc-button gc-button--action"
              disabled={disabled}
              onClick={() => void submit(true)}
            >
              {strings.createPr.submitDraft}
            </button>
            <button
              type="submit"
              className="gc-button gc-button--primary"
              aria-busy={busy}
              disabled={disabled}
            >
              {primaryLabel}
            </button>
          </div>
        </footer>
      </form>
    </div>
  );

  if (variant === 'modal') return <div className="gc-modal-backdrop">{dialog}</div>;
  return dialog;
}
