/**
 * Pure git remote URL parsing.
 *
 * No `vscode`, no `node:` imports, no network: every rule below is unit-testable
 * in isolation.
 *
 * Threat model: a remote URL may embed a credential (`https://user:token@host/…`
 * is what `git credential store` and CI checkouts produce). That credential must
 * never be logged, never be returned to the webview, and never be sent onward.
 * {@link stripCredentials} is the single choke point, and {@link parseRemoteUrl}
 * simply drops the userinfo component instead of carrying it in its result.
 */

/** Recognised remote URL, credential-free by construction. */
export interface ParsedRemoteUrl {
  /** Lower-cased host without port or userinfo, e.g. `github.com`. */
  host: string;
  owner: string;
  repo: string;
  /** `true` only for github.com itself. Enterprise hosts are reported by `host`. */
  isGitHub: boolean;
}

/** Hosts that are github.com proper. Everything else may be Enterprise. */
const GITHUB_HOSTS = new Set(['github.com', 'www.github.com']);

const SCHEMES = ['https://', 'http://', 'ssh://', 'git://', 'git+ssh://'];
/** `user@host:owner/repo` — the scp-like form git accepts without a scheme. */
const SCP_LIKE = /^(?:[^@\s/]+@)?([^@\s/:]+):(?!\/)(.+)$/;
const CONTROL_OR_SPACE = /[\s\u0000-\u001f\u007f]/;
const MAX_URL_LENGTH = 2048;

/**
 * Remove any `user:password@` / `user@` credential from a URL so it is safe to
 * log or hand to the UI. Non-URL input is returned unchanged.
 */
export function stripCredentials(url: string): string {
  return url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@]*@/i, '$1');
}

/**
 * Parse any form git accepts into `{ host, owner, repo, isGitHub }`, or `null`
 * when the value is not a recognisable `owner/repo` remote (local paths,
 * `file://`, malformed input).
 */
export function parseRemoteUrl(raw: unknown): ParsedRemoteUrl | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (value.length === 0 || value.length > MAX_URL_LENGTH) return null;
  if (CONTROL_OR_SPACE.test(value)) return null;

  const split = splitHostAndPath(value);
  if (split === null) return null;
  const owner = ownerRepoOf(split.path);
  if (owner === null) return null;
  const host = split.host.toLowerCase();
  return { host, owner: owner.owner, repo: owner.repo, isGitHub: GITHUB_HOSTS.has(host) };
}

/** Web base URL for a parsed remote, e.g. `https://github.com/owner/repo`. */
export function webUrlOf(remote: ParsedRemoteUrl): string {
  return `https://${remote.host}/${remote.owner}/${remote.repo}`;
}

/**
 * Split off the host and the repository path. Userinfo is discarded here, which
 * is why no credential can reach the returned object.
 */
function splitHostAndPath(value: string): { host: string; path: string } | null {
  const scheme = SCHEMES.find((s) => value.toLowerCase().startsWith(s));
  if (scheme !== undefined) {
    const rest = value.slice(scheme.length);
    const slash = rest.indexOf('/');
    if (slash <= 0) return null;
    const authority = rest.slice(0, slash);
    // Everything before the LAST `@` is userinfo; drop it, secret and all.
    const at = authority.lastIndexOf('@');
    const hostPort = at === -1 ? authority : authority.slice(at + 1);
    const host = stripPort(hostPort);
    if (host === null) return null;
    return { host, path: rest.slice(slash + 1) };
  }

  const scp = SCP_LIKE.exec(value);
  if (scp === null) return null;
  const host = stripPort(scp[1] as string);
  if (host === null) return null;
  return { host, path: scp[2] as string };
}

/** Drop an optional `:port` suffix and reject anything that is not a hostname. */
function stripPort(hostPort: string): string | null {
  const host = hostPort.replace(/:\d+$/, '');
  if (host.length === 0 || host.length > 253) return null;
  // A bare drive letter (`d`) or an IPv6 literal is not a remote we can link to.
  if (!/^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(host)) return null;
  if (!host.includes('.')) return null;
  return host;
}

/** Last two path segments, with `.git` and trailing slashes removed. */
function ownerRepoOf(path: string): { owner: string; repo: string } | null {
  const segments = path
    .replace(/\/+$/, '')
    .replace(/\.git$/i, '')
    .split('/')
    .filter((s) => s.length > 0);
  if (segments.length < 2) return null;
  const repo = segments[segments.length - 1] as string;
  const owner = segments[segments.length - 2] as string;
  if (repo.length === 0 || owner.length === 0) return null;
  return { owner, repo };
}
