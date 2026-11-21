/**
 * Add worktree modal dialog (P29, frame 66).
 *
 * Lets the user check out an existing local branch not already checked out into
 * a separate folder, previewing the exact `git worktree add -- <path> <branch>`
 * command and offering an Open folder action after creation.
 */
import { useEffect, useId, useMemo, useRef, useState, type FormEvent, type JSX } from 'react';
import { bridge, isBridgeError, newId } from './bridge';
import { canAddWorktree, canOfferAddWorktree, defaultWorktreePath, worktreeCommand } from './compareModel';
import { repoName, sanitizeGitText } from './format';
import { toErrorBody, useBranchesStore, useRepoStore } from './store';
import { Icon } from './ui';
import { useDialogFocusTrap } from './useDialogFocusTrap';
import { useT } from './useT';

function mapWorktreeError(err: unknown, branch: string, strings: ReturnType<typeof useT>): string {
  if (isBridgeError(err)) {
    switch (err.body.detail) {
      case 'not-absolute':
        return strings.worktree.err.notAbsolute;
      case 'exists-not-empty':
        return strings.worktree.err.notEmpty;
      case 'inside-git-dir':
        return strings.worktree.err.insideGit;
      case 'inside-worktree':
        return strings.worktree.err.insideWorktree;
      case 'is-worktree':
        return strings.worktree.err.isWorktree;
      case 'branch-in-use':
        return strings.worktree.err.branchInUse(sanitizeGitText(branch));
      default:
        return sanitizeGitText(err.body.message);
    }
  }
  return sanitizeGitText(toErrorBody(err).message);
}

export function AddWorktreeDialog(props: {
  initialBranch?: string | null;
  onClose(): void;
  onAdded(path: string): void;
}): JSX.Element {
  const strings = useT();
  const refs = useBranchesStore((s) => s.refs);
  const worktrees = useBranchesStore((s) => s.worktrees);
  const reloadBranches = useBranchesStore((s) => s.load);
  const status = useRepoStore((s) => s.status);

  const availableBranches = useMemo(
    () =>
      refs
        .filter(
          (r) =>
            r.kind === 'local' &&
            canOfferAddWorktree({ kind: 'local', name: r.shortName }, worktrees),
        )
        .map((r) => r.shortName),
    [refs, worktrees],
  );

  const repoRoot = useMemo(() => {
    const current = worktrees.find((w) => w.isCurrent) ?? worktrees[0];
    return status?.repoRoot ?? current?.path ?? '';
  }, [status?.repoRoot, worktrees]);

  const currentRepoName = useMemo(() => repoName(repoRoot), [repoRoot]);
  const existingPaths = useMemo(() => worktrees.map((w) => w.path), [worktrees]);

  const defaultBranch =
    props.initialBranch && availableBranches.includes(props.initialBranch)
      ? props.initialBranch
      : (availableBranches[0] ?? '');

  const [branch, setBranch] = useState<string>(defaultBranch);
  const [customPath, setCustomPath] = useState(false);
  const [folderPath, setFolderPath] = useState<string>(() =>
    defaultBranch.length > 0 && repoRoot.length > 0
      ? defaultWorktreePath(currentRepoName, defaultBranch, repoRoot)
      : '',
  );
  const [submitting, setSubmitting] = useState(false);
  const [errorText, setErrorText] = useState<string | null>(null);
  const [addedPath, setAddedPath] = useState<string | null>(null);

  const titleId = useId();
  const introId = useId();
  const branchId = useId();
  const folderId = useId();
  const errorId = useId();
  const commandLabelId = useId();

  const branchRef = useRef<HTMLSelectElement>(null);
  const folderRef = useRef<HTMLInputElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef<Element | null>(null);

  const handleClose = (): void => {
    if (submitting) return;
    props.onClose();
  };

  const { dialogRef, onKeyDown } = useDialogFocusTrap(handleClose);

  useEffect(() => {
    returnFocus.current = document.activeElement;
    if (availableBranches.length > 0 && branchRef.current !== null && !branchRef.current.disabled) {
      branchRef.current.focus();
    } else {
      folderRef.current?.focus();
    }
    return () => {
      const previous = returnFocus.current;
      if (previous instanceof HTMLElement) previous.focus();
    };
    // Focus runs once on mount; return-focus restores the opener on unmount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (branch.length === 0 && availableBranches.length > 0) {
      const first = availableBranches[0] ?? '';
      setBranch(first);
      if (!customPath && first.length > 0 && repoRoot.length > 0) {
        setFolderPath(defaultWorktreePath(currentRepoName, first, repoRoot));
      }
    }
  }, [branch, availableBranches, customPath, repoRoot, currentRepoName]);

  useEffect(() => {
    if (addedPath !== null) {
      closeButtonRef.current?.focus();
    }
  }, [addedPath]);

  const onBranchChange = (nextBranch: string): void => {
    setBranch(nextBranch);
    setErrorText(null);
    if (!customPath && nextBranch.length > 0 && repoRoot.length > 0) {
      setFolderPath(defaultWorktreePath(currentRepoName, nextBranch, repoRoot));
    }
  };

  const onFolderChange = (nextPath: string): void => {
    setCustomPath(true);
    setFolderPath(nextPath);
    setErrorText(null);
  };

  const browse = async (): Promise<void> => {
    try {
      const result = await bridge.request('actions/pickWorktreeFolder', {
        suggested: folderPath,
      });
      if (result.path !== null) {
        setCustomPath(true);
        setFolderPath(result.path);
        setErrorText(null);
      }
    } catch (err) {
      setErrorText(mapWorktreeError(err, branch, strings));
    }
  };

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (!canAddWorktree({ path: folderPath, branch }, existingPaths) || submitting) return;
    setSubmitting(true);
    setErrorText(null);
    try {
      await bridge.request('actions/git', {
        action: 'worktree-add',
        path: folderPath,
        branch,
        idempotencyKey: newId(),
      });
      await reloadBranches();
      props.onAdded(folderPath);
      setAddedPath(folderPath);
    } catch (err) {
      setErrorText(mapWorktreeError(err, branch, strings));
    } finally {
      setSubmitting(false);
    }
  };

  const openFolder = async (): Promise<void> => {
    if (addedPath === null) return;
    try {
      await bridge.request('actions/openWorktreeFolder', { path: addedPath });
    } catch (err) {
      setErrorText(mapWorktreeError(err, branch, strings));
    }
  };

  const canSubmit = canAddWorktree({ path: folderPath, branch }, existingPaths) && !submitting;

  return (
    <div className="gc-modal-backdrop">
      <div
        className="gc-modal gc-modal--start-work gc-worktree-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={introId}
        ref={dialogRef}
        onKeyDown={onKeyDown}
      >
        <header className="gc-start-work__header">
          <span className="gc-start-work__badge" aria-hidden="true">
            <Icon name="branch-add" />
          </span>
          <div className="gc-start-work__titles">
            <h2 className="gc-modal__title" id={titleId}>
              {strings.worktree.title}
            </h2>
            <p className="gc-start-work__subtitle" id={introId}>
              {strings.worktree.intro}
            </p>
          </div>
          <button
            type="button"
            className="gc-icon-button"
            aria-label={strings.worktree.closeAria}
            title={strings.worktree.closeAria}
            disabled={submitting}
            onClick={handleClose}
          >
            <Icon name="close" />
          </button>
        </header>

        {addedPath !== null ? (
          <div className="gc-start-work__body">
            <p className="gc-worktree-dialog__success">
              {strings.worktree.added(sanitizeGitText(addedPath))}
            </p>
            {errorText !== null && (
              <div role="alert" id={errorId} className="gc-worktree-dialog__error gc-field__error">
                <span aria-hidden="true">!</span>
                <span>{errorText}</span>
              </div>
            )}
            <div className="gc-modal__actions">
              <button
                ref={closeButtonRef}
                type="button"
                className="gc-button"
                onClick={handleClose}
              >
                {strings.worktree.closeAria}
              </button>
              <button
                type="button"
                className="gc-button gc-button--primary"
                onClick={() => void openFolder()}
              >
                <Icon name="folder" />
                {strings.worktree.openFolder}
              </button>
            </div>
          </div>
        ) : (
          <form className="gc-start-work__body" onSubmit={(event) => void submit(event)}>
            <div className="gc-field">
              <label htmlFor={branchId} className="gc-field__label">
                {strings.worktree.fieldBranch}
              </label>
              <select
                ref={branchRef}
                id={branchId}
                value={branch}
                disabled={submitting || availableBranches.length === 0}
                onChange={(event) => onBranchChange(event.target.value)}
              >
                {availableBranches.map((name) => (
                  <option key={name} value={name}>
                    {sanitizeGitText(name)}
                  </option>
                ))}
              </select>
            </div>

            <div className="gc-field">
              <label htmlFor={folderId} className="gc-field__label">
                {strings.worktree.fieldFolder}
              </label>
              <div className="gc-worktree-dialog__folder-row">
                <input
                  ref={folderRef}
                  id={folderId}
                  type="text"
                  value={folderPath}
                  disabled={submitting}
                  spellCheck={false}
                  autoComplete="off"
                  aria-invalid={errorText !== null ? 'true' : undefined}
                  aria-describedby={errorText !== null ? errorId : undefined}
                  onChange={(event) => onFolderChange(event.target.value)}
                />
                <button
                  type="button"
                  className="gc-button gc-worktree-dialog__browse"
                  disabled={submitting}
                  onClick={() => void browse()}
                >
                  {strings.worktree.browse}
                </button>
              </div>
            </div>

            {errorText !== null && (
              <div role="alert" id={errorId} className="gc-worktree-dialog__error gc-field__error">
                <span aria-hidden="true">!</span>
                <span>{errorText}</span>
              </div>
            )}

            <div className="gc-start-work__command gc-worktree-dialog__command">
              <span className="gc-start-work__command-label" id={commandLabelId}>
                {strings.worktree.commandHeading}
              </span>
              <code aria-describedby={commandLabelId}>
                {worktreeCommand(folderPath || '...', branch || '...')}
              </code>
            </div>

            <div className="gc-modal__actions">
              <button
                type="button"
                className="gc-button"
                disabled={submitting}
                onClick={handleClose}
              >
                {strings.worktree.cancel}
              </button>
              <button
                type="submit"
                className="gc-button gc-button--primary"
                disabled={!canSubmit}
              >
                {submitting ? strings.worktree.adding : strings.worktree.submit}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
