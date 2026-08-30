/**
 * GitHub status surface (FEAT-06).
 *
 * Deliberately small: this is metadata, not the main event. It shows the
 * connection state, a rate-limit badge with a countdown when the quota is spent,
 * `cached` / `offline` markers, open pull-request chips, and Connect/Disconnect.
 *
 * Rules held here: Indonesian strings, no hardcoded colour, status never encoded
 * by colour alone (every state carries a word), and every control is a real
 * button or link so the keyboard reaches it.
 */
import { useEffect, useState, type JSX } from 'react';
import {
  githubConnectionLabel,
  pullRequestLabel,
  rateLimitBadge,
  relativeTime,
  sanitizeGitText,
} from './format';
import { useGitHubStore } from './store';
import { InfoBanner } from './ui';
import type { PullRequestInfo } from '../messages';

/** Countdown tick. One second is enough for a quota timer and costs nothing. */
const TICK_MS = 1000;

export function GitHubPanel(): JSX.Element {
  const auth = useGitHubStore((s) => s.auth);
  const linkage = useGitHubStore((s) => s.linkage);
  const pullRequests = useGitHubStore((s) => s.pullRequests);
  const rateLimit = useGitHubStore((s) => s.rateLimit);
  const loading = useGitHubStore((s) => s.loading);
  const error = useGitHubStore((s) => s.error);
  const load = useGitHubStore((s) => s.load);
  const connect = useGitHubStore((s) => s.connect);
  const disconnect = useGitHubStore((s) => s.disconnect);

  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    void load();
  }, [load]);

  // Only tick while a countdown is actually on screen.
  const needsTick = rateLimit !== null && rateLimit.remaining === 0 && rateLimit.resetAt !== null;
  useEffect(() => {
    if (!needsTick) return undefined;
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, [needsTick]);

  const connected = auth?.connected === true;
  const badge = rateLimitBadge(rateLimit, now);

  return (
    <section className="gc-github" aria-label="Status GitHub">
      <header className="gc-github__head">
        <h3 className="gc-github__title">GitHub</h3>
        {/*
          The badge label always contains a word — `offline`, `Habis`, `Sisa …`,
          `cached` — so the tone colour is redundancy. `title` alone would not be
          reachable by keyboard, hence the explicit accessible name.
        */}
        <span
          className={`gc-github__badge gc-github__badge--${badge.tone}`}
          title={badge.title}
          aria-label={badge.title}
        >
          {badge.label}
        </span>
      </header>

      <p className="gc-github__state">
        {githubConnectionLabel({
          connected,
          login: auth?.login ?? null,
          ...(auth?.invalidToken === undefined ? {} : { invalidToken: auth.invalidToken }),
        })}
        {linkage?.available === true && linkage.owner !== null && (
          <>
            {' '}
            <code className="gc-github__repo">
              {sanitizeGitText(linkage.owner)}/{sanitizeGitText(linkage.repo ?? '')}
            </code>
          </>
        )}
      </p>

      {auth?.scopeWarning !== undefined && (
        <InfoBanner tone="warning" glyph="⚠">
          <strong>Scope token kurang.</strong>
          <span>{sanitizeGitText(auth.scopeWarning)}</span>
        </InfoBanner>
      )}

      {error !== null && (
        <InfoBanner tone="warning" glyph="!">
          <strong>Metadata GitHub tidak lengkap.</strong>
          <span>{sanitizeGitText(error.message)} Operasi git tetap berjalan lewat Git CLI.</span>
        </InfoBanner>
      )}

      {linkage?.available === false && (
        <p className="gc-github__note">
          Repository ini tidak punya remote GitHub, jadi tidak ada pull request atau tautan commit yang
          bisa ditampilkan. Semua operasi git tetap berjalan seperti biasa.
        </p>
      )}

      <div className="gc-github__actions">
        {connected ? (
          <button type="button" className="gc-button" onClick={() => void disconnect()}>
            Putuskan GitHub
          </button>
        ) : (
          <button type="button" className="gc-button gc-button--primary" onClick={() => void connect()}>
            Sambungkan GitHub
          </button>
        )}
        <button
          type="button"
          className="gc-button gc-button--quiet"
          aria-label="Muat ulang metadata GitHub"
          disabled={loading}
          onClick={() => void load()}
        >
          Muat ulang
        </button>
      </div>

      <PullRequestList pullRequests={pullRequests} connected={connected} />
    </section>
  );
}

/** Open pull-request chips. Each chip is a button so the keyboard reaches it. */
export function PullRequestList({
  pullRequests,
  connected,
}: {
  pullRequests: readonly PullRequestInfo[];
  connected: boolean;
}): JSX.Element | null {
  const openUrl = useGitHubStore((s) => s.openUrl);
  if (pullRequests.length === 0) {
    return connected ? (
      <p className="gc-github__note">
        Tidak ada pull request terbuka. Setelah Anda push sebuah branch, pull request-nya akan muncul di
        sini.
      </p>
    ) : null;
  }
  return (
    <ul className="gc-github__prs" aria-label="Pull request terbuka">
      {pullRequests.map((pr) => {
        // Title, refs, and author are whatever the PR opener typed. Sanitised for
        // both the chip text and the tooltip.
        const title = sanitizeGitText(pr.title);
        const tooltip =
          `${title} — ${sanitizeGitText(pr.headRef)} → ${sanitizeGitText(pr.baseRef)},` +
          ` oleh ${sanitizeGitText(pr.author)}, diperbarui ${relativeTime(pr.updatedAt)}`;
        return (
          <li key={pr.number}>
            <button
              type="button"
              className={`gc-chip gc-chip--pr gc-chip--pr-${pr.state}`}
              title={tooltip}
              // The state word is in `pullRequestLabel`, so the name carries the
              // number, the state, the branches, the author, and the age — the
              // border style is redundancy for sighted users, not the signal.
              aria-label={`Buka pull request ${pullRequestLabel(pr)}: ${tooltip}`}
              onClick={() => void openUrl(pr.url)}
            >
              <span className="gc-github__pr-number" aria-hidden="true">
                {pullRequestLabel(pr)}
              </span>
              <span className="gc-github__pr-title" aria-hidden="true">
                {title}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
