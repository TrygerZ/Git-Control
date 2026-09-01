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
import { bridge } from './bridge';
import { toErrorBody, useGitHubStore, useOperationStore, useSettingsStore } from './store';
import { EmptyState, ErrorBanner, FileListSkeleton, InfoBanner, MetadataSkeleton, Spinner } from './ui';
import type { CommitDetail, CommitFileChange, ErrorBody } from '../messages';

interface Props {
  hash: string | null;
}

export function Inspector({ hash }: Props): JSX.Element {
  const [detail, setDetail] = useState<CommitDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<ErrorBody | null>(null);
  const [parent, setParent] = useState<string | null>(null);
  const [opening, setOpening] = useState<string | null>(null);
  const [paging, setPaging] = useState(false);
  const pushToast = useOperationStore((s) => s.pushToast);
  const showLogs = useOperationStore((s) => s.showLogs);
  const linkage = useGitHubStore((s) => s.linkage);
  const openCommit = useGitHubStore((s) => s.openCommit);

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
      pushToast({ level: 'info', message: 'Hash disalin.' });
    } catch {
      pushToast({ level: 'warning', message: 'Tidak bisa menyalin ke clipboard.' });
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
          message: 'Tidak ada file tambahan yang bisa dimuat.',
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
        title="Belum ada commit dipilih."
        hint="Pilih salah satu commit di grafik untuk melihat detail perubahan."
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
        title="Detail commit tidak tersedia."
        hint="Commit ini mungkin sudah hilang dari repository, misalnya setelah rebase. Muat ulang grafik lalu pilih commit lain."
      />
    );

  const author = sanitizeGitText(detail.authorName);

  return (
    <section className="gc-inspector" aria-label="Detail commit">
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
              oleh {author} · {relativeTime(detail.authoredAt)}
            </p>
          </div>
        </div>

        <div className="gc-inspector__hashes">
          <code className="gc-inspector__short">{detail.shortHash}</code>
          <button
            type="button"
            className="gc-button gc-button--quiet"
            aria-label={`Salin hash pendek ${shortHash(detail.hash)}`}
            title="Salin 7 karakter pertama. Cukup untuk menyebut commit ini di percakapan."
            onClick={() => void copy(shortHash(detail.hash))}
          >
            Salin hash pendek
          </button>
          <button
            type="button"
            className="gc-button gc-button--quiet"
            aria-label="Salin hash lengkap 40 karakter"
            title="Salin 40 karakter penuh untuk dipakai di perintah git atau tautan."
            onClick={() => void copy(detail.hash)}
          >
            Salin hash lengkap
          </button>
          {linkage?.available === true && (
            // Opening happens host-side: the webview CSP forbids navigation.
            <button
              type="button"
              className="gc-button gc-button--quiet"
              aria-label={`Buka commit ${detail.shortHash} di GitHub`}
              title="Membuka commit ini di browser. Repository lokal Anda tidak disentuh."
              onClick={() => void openCommit(detail.hash)}
            >
              Buka di GitHub
            </button>
          )}
        </div>
      </header>

      <h3 className="gc-inspector__heading">Keterangan</h3>
      <dl className="gc-inspector__meta">
        <dt>Penulis</dt>
        <dd>
          {author} &lt;{sanitizeGitText(detail.authorEmail)}&gt;
        </dd>
        <dt>Ditulis</dt>
        <dd>
          {absoluteTime(detail.authoredAt)} · {relativeTime(detail.authoredAt)}
        </dd>
        <dt>Di-commit</dt>
        <dd>
          {absoluteTime(detail.committedAt)} · {relativeTime(detail.committedAt)}
          {detail.committerName !== detail.authorName &&
            ` oleh ${sanitizeGitText(detail.committerName)}`}
        </dd>
        <dt>Induk</dt>
        <dd>
          {detail.parents.length === 0 ? (
            'Tidak ada (commit pertama)'
          ) : (
            <ul className="gc-inspector__parents">
              {detail.parents.map((p) => (
                <li key={p}>
                  <code>{shortHash(p)}</code>
                </li>
              ))}
            </ul>
          )}
        </dd>
      </dl>

      {detail.refNames.length > 0 && (
        <>
          <h3 className="gc-inspector__heading">Ref</h3>
          <ul className="gc-inspector__refs" aria-label="Ref pada commit ini">
            {detail.refNames.map((ref) => (
              <li key={ref} className="gc-chip gc-chip--local">
                {sanitizeGitText(ref)}
              </li>
            ))}
          </ul>
        </>
      )}

      {detail.body.trim().length > 0 && (
        <>
          <h3 className="gc-inspector__heading">Pesan lengkap</h3>
          <pre className="gc-inspector__body" aria-label="Isi pesan commit">
            {sanitizeGitText(detail.body.trim())}
          </pre>
        </>
      )}

      <h3 className="gc-inspector__heading">File yang berubah</h3>

      {detail.parents.length > 1 && (
        <label className="gc-field">
          <span className="gc-field__label">Bandingkan dengan induk</span>
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
                Induk {i + 1} · {shortHash(p)}
              </option>
            ))}
          </select>
        </label>
      )}

      {totals !== null && (
        <p className="gc-inspector__totals">
          {formatCount(totals.files)} file ·{' '}
          <span className="gc-stat gc-stat--add">+{formatCount(totals.additions)}</span>{' '}
          <span className="gc-stat gc-stat--del">−{formatCount(totals.deletions)}</span>
          {totals.binary > 0 && ` · ${formatCount(totals.binary)} file binary`}
        </p>
      )}

      {detail.files.length === 0 ? (
        <EmptyState
          title="Commit ini tidak mengubah file."
          hint="Biasanya ini commit merge tanpa konflik, atau commit kosong yang dibuat dengan --allow-empty."
        />
      ) : (
        <ul className="gc-filelist" aria-label={`${formatCount(detail.files.length)} file yang berubah`}>
          {detail.files.map((file) => {
            // Paths come from git; sanitise once so the title and the two visible
            // spans cannot disagree. `baseName` sanitises internally too.
            const safePath = sanitizeGitText(file.path);
            const churn = file.binary
              ? 'file binary, diff teks tidak tersedia'
              : `${file.additions ?? 0} baris ditambah, ${file.deletions ?? 0} baris dihapus`;
            return (
              <li key={file.path} className="gc-filelist__item">
                <button
                  type="button"
                  className="gc-filelist__button"
                  // The visible row splits path and churn across three spans; the
                  // name puts them back in one sentence so nothing is lost or
                  // read out of order.
                  aria-label={`Buka diff ${safePath}, ${churn}`}
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
                      binary
                    </span>
                  ) : (
                    <span className="gc-filelist__stats" aria-hidden="true">
                      <span className="gc-stat gc-stat--add">+{file.additions ?? 0}</span>
                      <span className="gc-stat gc-stat--del">−{file.deletions ?? 0}</span>
                    </span>
                  )}
                </button>
                {opening === file.path && <Spinner label="Membuka diff…" />}
              </li>
            );
          })}
        </ul>
      )}

      {detail.truncated && (
        <InfoBanner tone="info" glyph="ellipsis">
          <strong>Diff dipangkas demi performa.</strong>
          <button
            type="button"
            className="gc-button gc-button--quiet"
            title="Ambil halaman file berikutnya dari commit ini. Hanya menambah isi daftar, tidak mengubah repository."
            disabled={paging}
            onClick={() => void loadMoreFiles()}
          >
            Muat lebih banyak
          </button>
          {paging && <Spinner label="Memuat file berikutnya…" />}
        </InfoBanner>
      )}
    </section>
  );
}
