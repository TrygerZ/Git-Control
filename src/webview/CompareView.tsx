/**
 * Compare sub-view inside the Branches sidebar route (P29).
 *
 * Compares two refs (`base...head` file diff, `base..head` commits): lets the
 * user pick or swap refs, previews `git diff base...head`, reveals commits in
 * the graph, and opens historical merge-base-to-head file diffs.
 */
import { useEffect, useId, useMemo, type JSX } from 'react';
import { bridge } from './bridge';
import { compareCommand, summaryLine } from './compareModel';
import { relativeTime, sanitizeGitText } from './format';
import {
  toErrorBody,
  useBranchesStore,
  useCompareStore,
  useOperationStore,
  useSettingsStore,
} from './store';
import { ErrorBanner, Icon, Spinner } from './ui';
import { useT } from './useT';

export function CompareView(): JSX.Element {
  const strings = useT();
  const language = useSettingsStore((s) => s.language);
  const refs = useBranchesStore((s) => s.refs);
  const showLogs = useOperationStore((s) => s.showLogs);
  const pushToast = useOperationStore((s) => s.pushToast);

  const base = useCompareStore((s) => s.base);
  const head = useCompareStore((s) => s.head);
  const result = useCompareStore((s) => s.result);
  const loading = useCompareStore((s) => s.loading);
  const error = useCompareStore((s) => s.error);
  const closeCompare = useCompareStore((s) => s.closeCompare);
  const setBase = useCompareStore((s) => s.setBase);
  const setHead = useCompareStore((s) => s.setHead);
  const swap = useCompareStore((s) => s.swap);
  const load = useCompareStore((s) => s.load);

  const baseId = useId();
  const headId = useId();

  useEffect(() => {
    if (result === null && !loading && error === null && base.length > 0 && head.length > 0) {
      void load();
    }
  }, [result, loading, error, base, head, load]);

  const { localRefs, remoteRefs, tagRefs, knownValues } = useMemo(() => {
    const local = refs.filter((r) => r.kind === 'local');
    const remote = refs.filter((r) => r.kind === 'remote');
    const tag = refs.filter((r) => r.kind === 'tag');
    const known = new Set([...local, ...remote, ...tag].map((r) => r.shortName));
    return { localRefs: local, remoteRefs: remote, tagRefs: tag, knownValues: known };
  }, [refs]);

  const renderOptions = (selectedValue: string): JSX.Element => (
    <>
      <option value="">{strings.compare.pickRef}</option>
      {selectedValue.length > 0 && !knownValues.has(selectedValue) && (
        <option value={selectedValue}>{sanitizeGitText(selectedValue)}</option>
      )}
      {localRefs.length > 0 && (
        <optgroup label={strings.branches.tabLocal}>
          {localRefs.map((r) => (
            <option key={r.refName} value={r.shortName}>
              {sanitizeGitText(r.shortName)}
            </option>
          ))}
        </optgroup>
      )}
      {remoteRefs.length > 0 && (
        <optgroup label={strings.branches.tabRemote}>
          {remoteRefs.map((r) => (
            <option key={r.refName} value={r.shortName}>
              {sanitizeGitText(r.shortName)}
            </option>
          ))}
        </optgroup>
      )}
      {tagRefs.length > 0 && (
        <optgroup label={strings.branches.tabTags}>
          {tagRefs.map((r) => (
            <option key={r.refName} value={r.shortName}>
              {sanitizeGitText(r.shortName)}
            </option>
          ))}
        </optgroup>
      )}
    </>
  );

  const renderBody = (): JSX.Element | null => {
    if (loading) {
      return (
        <div className="gc-compare__loading">
          <Spinner label={strings.compare.loading} />
        </div>
      );
    }
    if (result === null) return null;
    if (result.mergeBase === null) {
      return <p className="gc-compare__empty">{strings.compare.unrelated}</p>;
    }
    if (result.ahead === 0 && result.files.length === 0) {
      return <p className="gc-compare__empty">{strings.compare.upToDate}</p>;
    }

    const mergeBase = result.mergeBase;
    return (
      <>
        <p className="gc-compare__summary">{summaryLine(result, language)}</p>

        <section className="gc-section gc-compare__section" aria-label={strings.compare.commits}>
          <div className="gc-section__head">
            <h3 className="gc-section__title">
              <span className="gc-section__name">{strings.compare.commits}</span>
            </h3>
            <span className="gc-section__count">{result.commits.length}</span>
          </div>
          <ul className="gc-compare__list" role="list">
            {result.commits.map((c) => (
              <li key={c.hash} className="gc-compare__item">
                <button
                  type="button"
                  className="gc-compare__row gc-compare__commit"
                  title={strings.compare.revealCommit}
                  onClick={() => {
                    void bridge
                      .request('graph/revealCommit', { hash: c.hash })
                      .catch((err: unknown) =>
                        pushToast({ level: 'warning', message: toErrorBody(err).message }),
                      );
                  }}
                >
                  <span className="gc-compare__commit-top">
                    <code className="gc-compare__hash">{c.shortHash}</code>
                    <span className="gc-compare__subject">{sanitizeGitText(c.subject)}</span>
                  </span>
                  <span className="gc-compare__meta">
                    <span>{sanitizeGitText(c.author)}</span>
                    <span>{relativeTime(c.authoredAt, Date.now(), language)}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>

        <section className="gc-section gc-compare__section" aria-label={strings.compare.files}>
          <div className="gc-section__head">
            <h3 className="gc-section__title">
              <span className="gc-section__name">{strings.compare.files}</span>
            </h3>
            <span className="gc-section__count">{result.files.length}</span>
          </div>
          <ul className="gc-compare__list" role="list">
            {result.files.map((f) => (
              <li key={f.path} className="gc-compare__item">
                <button
                  type="button"
                  className="gc-compare__row gc-compare__file"
                  title={strings.compare.openDiff}
                  onClick={() => {
                    void bridge
                      .request('actions/openDiff', {
                        path: f.path,
                        hash: result.headHash,
                        parent: mergeBase,
                      })
                      .catch((err: unknown) =>
                        pushToast({ level: 'warning', message: toErrorBody(err).message }),
                      );
                  }}
                >
                  <span className="gc-compare__path">{sanitizeGitText(f.path)}</span>
                  <span className="gc-compare__churn">
                    {f.binary ? (
                      <span className="gc-compare__bin">bin</span>
                    ) : (
                      <>
                        <span className="gc-compare__add">+{f.additions ?? 0}</span>
                        <span className="gc-compare__del">-{f.deletions ?? 0}</span>
                      </>
                    )}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      </>
    );
  };

  return (
    <div className="gc-compare">
      <div className="gc-compare__head">
        <button
          type="button"
          className="gc-button gc-button--quiet gc-compare__back"
          onClick={closeCompare}
        >
          <Icon name="chevron-left" />
          <span>{strings.compare.back}</span>
        </button>
        <h2 className="gc-compare__title">{strings.compare.title}</h2>
      </div>

      <div className="gc-compare__pickers">
        <div className="gc-field gc-compare__picker">
          <label htmlFor={baseId} className="gc-field__label">
            {strings.compare.base}
          </label>
          <select id={baseId} value={base} onChange={(e) => setBase(e.target.value)}>
            {renderOptions(base)}
          </select>
        </div>

        <button
          type="button"
          className="gc-icon-button gc-compare__swap"
          aria-label={strings.compare.swap}
          title={strings.compare.swap}
          onClick={swap}
        >
          <Icon name="refresh" />
        </button>

        <div className="gc-field gc-compare__picker">
          <label htmlFor={headId} className="gc-field__label">
            {strings.compare.head}
          </label>
          <select id={headId} value={head} onChange={(e) => setHead(e.target.value)}>
            {renderOptions(head)}
          </select>
        </div>
      </div>

      {base.length > 0 && head.length > 0 && (
        <code className="gc-compare__command">{compareCommand(base, head)}</code>
      )}

      {error !== null && (
        <ErrorBanner
          error={{ status: 400, code: 'SERVER_ERROR', message: error }}
          onShowLogs={showLogs}
        />
      )}

      {renderBody()}
    </div>
  );
}
