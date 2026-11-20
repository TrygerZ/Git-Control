/**
 * Run workflow dialog (P27, frame 59).
 *
 * 340 px sidebar modal: Workflow, Branch, optional parsed `workflow_dispatch`
 * inputs (or unreadable-inputs fallback with Open on GitHub), read-only command
 * preview, Cancel, and Run workflow.
 */
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type JSX,
} from 'react';
import { validateBranchName } from '../validation';
import {
  branchesWithRuns,
  defaultInputValues,
  dispatchCommand,
  missingRequired,
} from './actionsModel';
import { sanitizeGitText } from './format';
import { useActionsStore, useGitHubStore, useRepoStore } from './store';
import { Icon } from './ui';
import { useDialogFocusTrap } from './useDialogFocusTrap';
import { useT } from './useT';

export interface RunWorkflowDialogProps {
  owner: string;
  repo: string;
  onCancel(): void;
}

export function RunWorkflowDialog({ owner, repo, onCancel }: RunWorkflowDialogProps): JSX.Element {
  const strings = useT();
  const workflows = useActionsStore((s) => s.workflows);
  const runs = useActionsStore((s) => s.runs);
  const filterBranch = useActionsStore((s) => s.branch);
  const filterWorkflowId = useActionsStore((s) => s.workflowId);
  const dispatchInputs = useActionsStore((s) => s.dispatchInputs);
  const dispatchInputsLoading = useActionsStore((s) => s.dispatchInputsLoading);
  const dispatching = useActionsStore((s) => s.dispatching);
  const dispatchError = useActionsStore((s) => s.dispatchError);
  const loadDispatchInputs = useActionsStore((s) => s.loadDispatchInputs);
  const dispatch = useActionsStore((s) => s.dispatch);

  const status = useRepoStore((s) => s.status);
  const graph = useRepoStore((s) => s.graph);
  const openUrl = useGitHubStore((s) => s.openUrl);

  const activeWorkflows = useMemo(
    () => workflows.filter((wf) => wf.state === 'active'),
    [workflows],
  );

  const [selectedWorkflowId, setSelectedWorkflowId] = useState<number | null>(() => {
    if (filterWorkflowId !== null && activeWorkflows.some((wf) => wf.id === filterWorkflowId)) {
      return filterWorkflowId;
    }
    return activeWorkflows[0]?.id ?? null;
  });
  const [branch, setBranch] = useState<string>(() => filterBranch ?? status?.branch ?? 'main');
  const [inputValues, setInputValues] = useState<Record<string, string>>({});
  const [showValidation, setShowValidation] = useState(false);

  const handleCancel = (): void => {
    if (dispatching) return;
    onCancel();
  };

  const { dialogRef, onKeyDown } = useDialogFocusTrap(handleCancel);
  const workflowSelectRef = useRef<HTMLSelectElement | null>(null);
  const branchInputRef = useRef<HTMLInputElement | null>(null);
  const returnFocus = useRef<Element | null>(null);
  const seededKeyRef = useRef<string | null>(null);
  const lastWorkflowRef = useRef<number | null>(selectedWorkflowId);
  const dirtyKeysRef = useRef<Set<string>>(new Set());

  const titleId = useId();
  const introId = useId();
  const branchListId = useId();
  const branchErrId = useId();
  const commandLabelId = useId();
  const fieldPrefixId = useId();

  useEffect(() => {
    returnFocus.current = document.activeElement;
    if (workflowSelectRef.current !== null) {
      workflowSelectRef.current.focus();
    } else {
      branchInputRef.current?.focus();
    }
    return () => {
      const previous = returnFocus.current;
      if (previous instanceof HTMLElement) previous.focus();
    };
  }, []);

  useEffect(() => {
    if (activeWorkflows.length === 0) {
      if (selectedWorkflowId !== null) setSelectedWorkflowId(null);
      return;
    }
    if (selectedWorkflowId === null || !activeWorkflows.some((wf) => wf.id === selectedWorkflowId)) {
      const preferred =
        filterWorkflowId !== null && activeWorkflows.some((wf) => wf.id === filterWorkflowId)
          ? filterWorkflowId
          : activeWorkflows[0]!.id;
      setSelectedWorkflowId(preferred);
    }
  }, [activeWorkflows, selectedWorkflowId, filterWorkflowId]);

  const branchValid = validateBranchName(branch);
  const selectedWorkflow = activeWorkflows.find((wf) => wf.id === selectedWorkflowId);
  const entryKey =
    selectedWorkflow !== undefined && branchValid ? `${selectedWorkflow.id}:${branch}` : null;
  const entry = entryKey !== null ? dispatchInputs[entryKey] : undefined;

  useEffect(() => {
    if (selectedWorkflow === undefined || !branchValid) return;
    void loadDispatchInputs(selectedWorkflow.id, branch);
  }, [selectedWorkflow, branch, branchValid, loadDispatchInputs]);

  useEffect(() => {
    if (entry === undefined || entryKey === null || seededKeyRef.current === entryKey) return;
    seededKeyRef.current = entryKey;
    const workflowChanged = lastWorkflowRef.current !== (selectedWorkflow?.id ?? null);
    lastWorkflowRef.current = selectedWorkflow?.id ?? null;

    if (!entry.parsed) {
      dirtyKeysRef.current.clear();
      setInputValues({});
      setShowValidation(false);
      return;
    }

    const defaults = defaultInputValues(entry.inputs);
    if (workflowChanged) {
      dirtyKeysRef.current.clear();
      setInputValues(defaults);
      setShowValidation(false);
      return;
    }

    setInputValues((prev) => {
      const next = { ...defaults };
      for (const input of entry.inputs) {
        if (dirtyKeysRef.current.has(input.name) && prev[input.name] !== undefined) {
          next[input.name] = prev[input.name]!;
        }
      }
      return next;
    });
  }, [entry, entryKey, selectedWorkflow?.id]);

  const branchSuggestions = useMemo(() => {
    const seen = new Set<string>(branchesWithRuns(runs, status?.branch ?? null));
    if (graph?.refs !== undefined) {
      for (const ref of graph.refs) {
        if (ref.kind === 'local' && ref.shortName.length > 0) {
          seen.add(ref.shortName);
        }
      }
    }
    return Array.from(seen);
  }, [runs, status?.branch, graph?.refs]);

  const missing = useMemo(
    () => (entry?.parsed ? missingRequired(entry.inputs, inputValues) : []),
    [entry, inputValues],
  );
  const missingSet = useMemo(() => new Set(missing), [missing]);

  const preparedInputs = useMemo(() => {
    if (!entry?.parsed || entry.inputs.length === 0) return undefined;
    const out: Record<string, string> = {};
    for (const input of entry.inputs) {
      const value = inputValues[input.name] ?? '';
      if (value.length > 0) out[input.name] = value;
    }
    return Object.keys(out).length > 0 ? out : undefined;
  }, [entry, inputValues]);

  const canSubmit =
    selectedWorkflow !== undefined &&
    branchValid &&
    !dispatchInputsLoading &&
    entry !== undefined &&
    missing.length === 0 &&
    !dispatching;

  const command = dispatchCommand(
    owner,
    repo,
    selectedWorkflow?.path ?? '',
    branchValid ? branch : 'main',
    preparedInputs,
  );

  const setInputValue = (name: string, value: string): void => {
    dirtyKeysRef.current.add(name);
    setInputValues((prev) => ({ ...prev, [name]: value }));
  };

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setShowValidation(true);
    if (!canSubmit || selectedWorkflow === undefined) return;
    await dispatch({
      workflowId: selectedWorkflow.id,
      branch,
      ...(preparedInputs === undefined ? {} : { inputs: preparedInputs }),
    });
  };

  return (
    <div className="gc-modal-backdrop">
      <div
        className="gc-modal gc-modal--start-work gc-run-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={introId}
        ref={dialogRef}
        onKeyDown={onKeyDown}
      >
        <header className="gc-start-work__header">
          <span className="gc-start-work__badge" aria-hidden="true">
            <Icon name="play" />
          </span>
          <div className="gc-start-work__titles">
            <h2 className="gc-modal__title" id={titleId}>
              {strings.actionsWrite.runWorkflow}
            </h2>
            <p className="gc-start-work__subtitle" id={introId}>
              {strings.actionsWrite.dialogIntro}
            </p>
          </div>
          <button
            type="button"
            className="gc-icon-button"
            aria-label={strings.actionsWrite.cancel}
            title={strings.actionsWrite.cancel}
            disabled={dispatching}
            onClick={handleCancel}
          >
            <Icon name="close" />
          </button>
        </header>

        <form className="gc-start-work__body" onSubmit={(e) => void submit(e)}>
          {activeWorkflows.length === 0 ? (
            <p className="gc-run-dialog__loading" role="status">
              {strings.actionsWrite.noActiveWorkflows}
            </p>
          ) : (
            <label className="gc-field">
              <span className="gc-field__label">{strings.actionsWrite.fieldWorkflow}</span>
              <select
                ref={workflowSelectRef}
                value={selectedWorkflow?.id ?? ''}
                disabled={dispatching}
                aria-label={strings.actionsWrite.fieldWorkflow}
                onChange={(event) => {
                  const nextId = Number(event.target.value);
                  if (Number.isFinite(nextId)) setSelectedWorkflowId(nextId);
                }}
              >
                {activeWorkflows.map((wf) => (
                  <option key={wf.id} value={wf.id}>
                    {sanitizeGitText(wf.name)}
                  </option>
                ))}
              </select>
            </label>
          )}

          <label className="gc-field">
            <span className="gc-field__label">{strings.actionsWrite.fieldBranch}</span>
            <input
              ref={branchInputRef}
              type="text"
              list={branchListId}
              value={branch}
              disabled={dispatching}
              aria-label={strings.actionsWrite.fieldBranch}
              aria-required="true"
              aria-invalid={!branchValid}
              aria-describedby={!branchValid ? branchErrId : undefined}
              onChange={(event) => setBranch(event.target.value)}
            />
          </label>
          <datalist id={branchListId}>
            {branchSuggestions.map((item) => (
              <option key={item} value={item} />
            ))}
          </datalist>
          {!branchValid && (
            <p className="gc-field__error" id={branchErrId} role="alert">
              <span aria-hidden="true">!</span>
              <span>{strings.actionsWrite.inputRequired(strings.actionsWrite.fieldBranch)}</span>
            </p>
          )}

          {dispatchInputsLoading && (
            <p className="gc-run-dialog__loading" role="status">
              {strings.actionsWrite.loadingInputs}
            </p>
          )}

          {!dispatchInputsLoading && entry !== undefined && !entry.parsed && (
            <div className="gc-run-dialog__fallback" role="status">
              <p>{strings.actionsWrite.inputsUnreadable}</p>
              <p>{strings.actionsWrite.openOnGitHubHint}</p>
              {entry.webUrl !== null && (
                <button
                  type="button"
                  className="gc-button"
                  disabled={dispatching}
                  onClick={() => void openUrl(entry.webUrl as string)}
                >
                  <Icon name="external" />
                  {strings.actionsWrite.openOnGitHub}
                </button>
              )}
            </div>
          )}

          {!dispatchInputsLoading && entry !== undefined && entry.parsed && entry.inputs.map((input) => {
            const cleanName = sanitizeGitText(input.name);
            const cleanDesc = sanitizeGitText(input.description);
            const value = inputValues[input.name] ?? '';
            const isMissing = showValidation && missingSet.has(input.name);
            const descId = `${fieldPrefixId}-${input.name}-desc`;
            const errId = `${fieldPrefixId}-${input.name}-err`;
            const describedByParts: string[] = [];
            if (cleanDesc.length > 0) describedByParts.push(descId);
            if (isMissing) describedByParts.push(errId);
            const describedBy = describedByParts.length > 0 ? describedByParts.join(' ') : undefined;

            if (input.type === 'boolean') {
              return (
                <div className="gc-field" key={input.name}>
                  <label className="gc-run-dialog__checkbox">
                    <input
                      type="checkbox"
                      checked={value === 'true'}
                      disabled={dispatching}
                      aria-required={input.required ? 'true' : undefined}
                      aria-describedby={describedBy}
                      onChange={(event) =>
                        setInputValue(input.name, event.target.checked ? 'true' : 'false')
                      }
                    />
                    <span>{strings.actionsWrite.inputLabel(cleanName)}</span>
                  </label>
                  {cleanDesc.length > 0 && (
                    <span className="gc-field__hint" id={descId}>
                      {cleanDesc}
                    </span>
                  )}
                </div>
              );
            }

            return (
              <div className="gc-field" key={input.name}>
                <label className="gc-field">
                  <span className="gc-field__label">{strings.actionsWrite.inputLabel(cleanName)}</span>
                  {input.type === 'choice' ? (
                    <select
                      value={value}
                      disabled={dispatching}
                      aria-label={strings.actionsWrite.inputLabel(cleanName)}
                      aria-required={input.required ? 'true' : undefined}
                      aria-invalid={isMissing ? 'true' : undefined}
                      aria-describedby={describedBy}
                      onChange={(event) => setInputValue(input.name, event.target.value)}
                    >
                      {input.options.map((opt) => (
                        <option key={opt} value={opt}>
                          {sanitizeGitText(opt)}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      type="text"
                      value={value}
                      maxLength={1024}
                      disabled={dispatching}
                      aria-label={strings.actionsWrite.inputLabel(cleanName)}
                      aria-required={input.required ? 'true' : undefined}
                      aria-invalid={isMissing ? 'true' : undefined}
                      aria-describedby={describedBy}
                      onChange={(event) => setInputValue(input.name, event.target.value)}
                    />
                  )}
                </label>
                {cleanDesc.length > 0 && (
                  <span className="gc-field__hint" id={descId}>
                    {cleanDesc}
                  </span>
                )}
                {isMissing && (
                  <p className="gc-field__error" id={errId} role="alert">
                    <span aria-hidden="true">!</span>
                    <span>{strings.actionsWrite.inputRequired(cleanName)}</span>
                  </p>
                )}
              </div>
            );
          })}

          {dispatchError !== null && (
            <div className="gc-run-dialog__error" role="alert">
              <p>{sanitizeGitText(dispatchError.message)}</p>
              {dispatchError.detail !== undefined && dispatchError.detail.length > 0 && (
                <p className="gc-help-text">{sanitizeGitText(dispatchError.detail)}</p>
              )}
              {entry?.webUrl != null && entry.parsed && (
                <button
                  type="button"
                  className="gc-button"
                  disabled={dispatching}
                  onClick={() => void openUrl(entry.webUrl as string)}
                >
                  <Icon name="external" />
                  {strings.actionsWrite.openOnGitHub}
                </button>
              )}
            </div>
          )}

          {selectedWorkflow !== undefined && (
            <div className="gc-start-work__command">
              <span className="gc-start-work__command-label" id={commandLabelId}>
                {strings.actionsWrite.commandHeading}
              </span>
              <code aria-describedby={commandLabelId}>{command}</code>
            </div>
          )}

          <div className="gc-modal__actions">
            <button
              type="button"
              className="gc-button"
              disabled={dispatching}
              onClick={handleCancel}
            >
              {strings.actionsWrite.cancel}
            </button>
            <button
              type="submit"
              className="gc-button gc-button--primary"
              disabled={!canSubmit}
            >
              <Icon name="play" />
              {dispatching ? strings.actionsWrite.dispatching : strings.actionsWrite.confirmRun}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
