/**
 * Commit inspector (FEAT-05).
 *
 * Loads `commits/detail` for the selected hash and renders metadata, ref chips,
 * parents, and the per-file stats. Merge commits get a parent selector; changing
 * it re-requests the diff so the file list matches the chosen comparison.
 *
 * Structured like the reference's right-hand panel: one large title, one `oleh …
 * pada …` line under it, then titled sections. The hash buttons that used to crowd
 * the title now sit in their own quiet row, because "which commit is this" and "copy
 * its id" are not the same question.
 */
import { useEffect, useMemo, useState, type JSX } from 'react';
import {
  absoluteTime,
  authorInitials,
  baseName,
  formatCount,
  relativeTime,
  sanitizeGitText,
  shortHash,
} from './format';
import { useT } from './useT';
import { bridge } from './bridge';
import { toErrorBody, useGitHubStore, useOperationStore, useSettingsStore } from './store';
import { EmptyState, ErrorBanner, FileListSkeleton, Icon, InfoBanner, MetadataSkeleton, Spinner } from './ui';
import type { CommitDetail, CommitFileChange, ErrorBody } from '../messages';

interface Props {
  hash: string | null;
}

export function Inspector({ hash }: Props): JSX.Element {
  const strings = useT();
  const language = useSettingsStore((x) => x.language);
  const [detail, setDetail] = useState<CommitDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<ErrorBody | null>(null);
  const [parent, setParent] = useState<string | null>(null);
  const [opening, setOpening] = useState<string | null>(null);
  const [paging, setPaging] = useState(false);
  const pushToast = useOperationStore((st) => st.pushToast);
  const showLogs = useOperationStore((st) => st.showLogs);
  const linkage = useGitHubStore((st) => st.linkage);
  const openCommit = useGitHubStore((st) => st.openCommit);

  useEffect(() => {
    if (hash === null) {
      setDetail(null);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    bridge
      .request('commits/detail', { hash })
      .then((data) => {
        if (cancelled) return;
        setDetail(data);
        setParent(data.parents[0] ?? null);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(toErrorBody(err));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [hash]);

  const copy = async (text: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text);
      pushToast({ level: 'info', message: strings.inspector.toastHashCopied });
    } catch {
      pushToast({ level: 'warning', message: strings.inspector.toastCopyFailed });
    }
  };

  const openDiff = async (file: CommitFileChange): Promise<void> => {
    if (hash === null) return;
    setOpening(file.path);
    try {
      await bridge.request('actions/openDiff', {
        path: file.path,
        hash,
        ...(parent === null ? {} : { parent }),
      });
    } catch (err) {
      const body = toErrorBody(err);
      pushToast({
        level: body.code === 'UNAVAILABLE' ? 'warning' : 'error',
        message: body.message,
        ...(body.detail === undefined ? {} : { detail: body.detail }),
      });
    } finally {
      setOpening(null);
    }
  };

  const totals = useMemo(() => detail?.totals ?? null, [detail]);

  /**
   * Append the next page of files. The cursor comes from the server's
   * `nextFileCursor`, never computed here, and the path de-dupe stays as a cheap
   * guard against a repeated page.
   */
  const loadMoreFiles = async (): Promise<void> => {
    if (hash === null || detail === null || paging) return;
    const cursor = detail.nextFileCursor;
    if (cursor === null) return;
    setPaging(true);
    try {
      const page = await bridge.request('commits/detail', { hash, fileCursor: cursor });
      const known = new Set(detail.files.map((f) => f.path));
      const added = page.files.filter((f) => !known.has(f.path));
      if (added.length === 0) {
        pushToast({
          level: 'warning',
          message: strings.inspector.toastNoMoreFiles,
        });
        setDetail({ ...detail, truncated: false, nextFileCursor: null });
      } else {
        setDetail({
          ...detail,
          files: [...detail.files, ...added],
          truncated: page.truncated,
          nextFileCursor: page.nextFileCursor,
        });
      }
    } catch (err) {
      pushToast({ level: 'error', message: toErrorBody(err).message });
    } finally {
      setPaging(false);
    }
  };

  if (hash === null) {
    return (
      <EmptyState
        title={strings.inspector.emptyNoSelectionTitle}
        hint={strings.inspector.emptyNoSelectionHint}
      />
    );
  }

  if (error !== null) {
    return (
      <div className="gc-inspector">
        <ErrorBanner error={error} onShowLogs={showLogs} />
      </div>
    );
  }

  if (loading && detail === null) {
    return (
      <div className="gc-inspector">
        <MetadataSkeleton />
        <FileListSkeleton />
      </div>
    );
  }

  if (detail === null)
    return (
      <EmptyState
        title={strings.inspector.emptyDetailUnavailableTitle}
        hint={strings.inspector.emptyDetailUnavailableHint}
      />
    );

  const author = sanitizeGitText(detail.authorName);

  return (
    <section className="gc-inspector" aria-label={strings.inspector.panelAria}>
      <header className="gc-inspector__head">
        {/*
          Avatar plus title plus one `oleh … pada …` line, as in the reference
          inspector. The avatar is `aria-hidden`: the author's full name is in the
          meta line immediately below, and a lone initial announced before it reads
          as a stray letter.
        */}
        <div className="gc-inspector__identity">
          <span className="gc-avatar" aria-hidden="true">
            {authorInitials(detail.authorName)}
          </span>
          <div className="gc-inspector__titles">
            <h2 className="gc-inspector__subject">{sanitizeGitText(detail.subject)}</h2>
            <p className="gc-inspector__byline">
              {strings.inspector.byAuthor(author, relativeTime(detail.authoredAt, Date.now(), language))}
            </p>
          </div>
        </div>

        <div className="gc-inspector__hashes">
          <code className="gc-inspector__short gc-inspector__hash-value">
            {detail.shortHash}
          </code>
          {/*
            Two copy actions differ only in hash length. Previous design used the
            same stacked-squares glyph for both, indistinguishable without hover.
            Fix: textual hint instead of a second metaphor — "7" is literal for
            the 7-char short hash, honest at 16px and needs no new icon (avoids
            repeating the add/diff-added strokeWidth-only trap). Full hash keeps
            the clipboard glyph; short keeps the number. Group stays segmented so
            the row still fits 250px.
          */}
          <div className="gc-inspector__copy-group" role="group" aria-label={strings.inspector.copyGroupAria}>
            <button
              type="button"
              className="gc-icon-button"
              aria-label={strings.inspector.copyShortHashAria(detail.shortHash)}
              title={strings.inspector.copyShortHashTitle}
              onClick={() => void copy(detail.shortHash)}
            >
              <span className="gc-inspector__copy-mark" aria-hidden="true">
                7
              </span>
            </button>
            <button
              type="button"
              className="gc-icon-button"
              aria-label={strings.inspector.copyFullHashAria}
              title={strings.inspector.copyFullHashTitle}
              onClick={() => void copy(detail.hash)}
            >
              <Icon name="copy" />
            </button>
          </div>
          {linkage?.available === true && (
            // External leaves the app — not in the clipboard rhythm. Own button
            // with divider, icon-only for the same width reason as the copy pair.
            <button
              type="button"
              className="gc-icon-button gc-inspector__external"
              aria-label={strings.inspector.openGitHubAria(detail.shortHash)}
              title={strings.inspector.openGitHubTitle}
              onClick={() => void openCommit(detail.hash)}
            >
              <Icon name="external" />
            </button>
          )}
        </div>
      </header>

      <section className="gc-inspector__block">
        <h3 className="gc-inspector__heading">{strings.inspector.sectionDetails}</h3>
        <dl className="gc-inspector__meta">
          <dt>{strings.inspector.labelAuthor}</dt>
          <dd>
            {author} &lt;{sanitizeGitText(detail.authorEmail)}&gt;
          </dd>
          <dt>{strings.inspector.labelAuthored}</dt>
          <dd>
            {absoluteTime(detail.authoredAt, language)} · {relativeTime(detail.authoredAt, Date.now(), language)}
          </dd>
          <dt>{strings.inspector.labelCommitted}</dt>
          <dd>
            {absoluteTime(detail.committedAt, language)} · {relativeTime(detail.committedAt, Date.now(), language)}
            {detail.committerName !== detail.authorName &&
              strings.inspector.committedBy(sanitizeGitText(detail.committerName))}
          </dd>
          <dt>{strings.inspector.labelParents}</dt>
          <dd>
            {detail.parents.length === 0 ? (
              strings.inspector.noParents
            ) : (
              <ul className="gc-inspector__parents">
                {detail.parents.map((p) => (
                  <li key={p}>
                    <code className="gc-inspector__hash-value">{shortHash(p)}</code>
                  </li>
                ))}
              </ul>
            )}
          </dd>
        </dl>
      </section>

      {detail.refNames.length > 0 && (
        <section className="gc-inspector__block">
          <h3 className="gc-inspector__heading">{strings.inspector.sectionRefs}</h3>
          <ul className="gc-inspector__refs" aria-label={strings.inspector.refsAria}>
            {detail.refNames.map((ref) => (
              <li key={ref} className="gc-chip gc-chip--local">
                {sanitizeGitText(ref)}
              </li>
            ))}
          </ul>
        </section>
      )}

      {detail.body.trim().length > 0 && (
        <section className="gc-inspector__block">
          <h3 className="gc-inspector__heading">{strings.inspector.sectionBody}</h3>
          <pre className="gc-inspector__body" aria-label={strings.inspector.bodyAria}>
            {sanitizeGitText(detail.body.trim())}
          </pre>
        </section>
      )}

      <section className="gc-inspector__block gc-inspector__block--files">
        <h3 className="gc-inspector__heading">{strings.inspector.sectionFiles}</h3>

        {detail.parents.length > 1 && (
          <label className="gc-field">
            <span className="gc-field__label">{strings.inspector.compareParentLabel}</span>
            <select
              value={parent ?? ''}
              onChange={(e) => {
                setParent(e.target.value);
                // The host diffs against the first parent, so switching parents
                // only changes what `actions/openDiff` is asked for.
                setOpening(null);
              }}
            >
              {detail.parents.map((p, i) => (
                <option key={p} value={p}>
                  {strings.inspector.parentOption(i + 1, shortHash(p))}
                </option>
              ))}
            </select>
          </label>
        )}

        {totals !== null && (
          <p className="gc-inspector__totals">
            {strings.inspector.totalsFiles(formatCount(totals.files, language))} ·{' '}
            <span className="gc-stat gc-stat--add">+{formatCount(totals.additions, language)}</span>{' '}
            <span className="gc-stat gc-stat--del">−{formatCount(totals.deletions, language)}</span>
            {totals.binary > 0 && ` · ${strings.inspector.totalsBinary(formatCount(totals.binary, language))}`}
          </p>
        )}

        {detail.files.length === 0 ? (
          <EmptyState
            title={strings.inspector.emptyFilesTitle}
            hint={strings.inspector.emptyFilesHint}
          />
        ) : (
          <ul className="gc-filelist" aria-label={strings.inspector.fileListAria(formatCount(detail.files.length, language))}>
            {detail.files.map((file) => {
              // Paths come from git; sanitise once so the title and the two visible
              // spans cannot disagree. `baseName` sanitises internally too.
              const safePath = sanitizeGitText(file.path);
              const churn = file.binary
                ? strings.inspector.churnBinary
                : strings.inspector.churnSummary(file.additions ?? 0, file.deletions ?? 0);
              return (
                <li key={file.path} className="gc-filelist__item">
                  <button
                    type="button"
                    className="gc-filelist__button"
                    // The visible row splits path and churn across three spans; the
                    // name puts them back in one sentence so nothing is lost or
                    // read out of order.
                    aria-label={strings.inspector.openDiffAria(safePath, churn)}
                    onClick={() => void openDiff(file)}
                    disabled={opening === file.path}
                  >
                    <span className="gc-filelist__name" aria-hidden="true" title={safePath}>
                      {file.origPath !== undefined
                        ? `${sanitizeGitText(file.origPath)} → ${baseName(file.path)}`
                        : baseName(file.path)}
                    </span>
                    <span className="gc-filelist__dir" aria-hidden="true">
                      {safePath}
                    </span>
                    {file.binary ? (
                      <span className="gc-filelist__binary" aria-hidden="true">
                        {strings.inspector.churnBinary}
                      </span>
                    ) : (
                      <span className="gc-filelist__stats" aria-hidden="true">
                        <span className="gc-stat gc-stat--add">+{file.additions ?? 0}</span>
                        <span className="gc-stat gc-stat--del">−{file.deletions ?? 0}</span>
                      </span>
                    )}
                  </button>
                  {opening === file.path && <Spinner label={strings.inspector.openingDiff} />}
                </li>
              );
            })}
          </ul>
        )}

        {detail.truncated && (
          <InfoBanner tone="info" glyph="ellipsis">
            <strong>{strings.inspector.diffTruncated}</strong>
            <button
              type="button"
              className="gc-button gc-button--quiet"
              title={strings.inspector.loadMoreTitle}
              disabled={paging}
              onClick={() => void loadMoreFiles()}
            >
              {strings.inspector.loadMore}
            </button>
            {paging && <Spinner label={strings.inspector.loadingMore} />}
          </InfoBanner>
        )}
      </section>
    </section>
  );
}
