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
 *
 * The userinfo component is matched up to its LAST `@`, matching
 * {@link splitHostAndPath}. Stopping at the first `@` would leave the tail of a
 * credential behind whenever the username or the secret itself contains one —
 * `https://user@corp:SECRET@host/o/r` is a real shape, and a first-`@` match
 * would emit `https://corp:SECRET@host/o/r`.
 *
 * A backslash ends the authority for WHATWG URL parsers, so it also ends the
 * userinfo here. Without that exclusion `https://evil.example\@github.com/o/r`
 * would be rewritten to `https://github.com/o/r` — a display lie naming a host
 * the URL does not resolve to.
 */
export function stripCredentials(url: string): string {
  return url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/\\]*@/i, '$1');
}

/** Default GitHub API base. Also the value shipped in `package.json`. */
export const DEFAULT_GITHUB_API_URL = 'https://api.github.com';

export interface GitHubApiBase {
  /** API base to talk to, without a trailing slash. */
  apiUrl: string;
  /**
   * `true` when the stored token may be sent to {@link apiUrl}.
   *
   * Only two bases earn this: the default GitHub API, and a base the user typed
   * into `gitControl.githubApiUrl` themselves. A base *derived* from a remote URL
   * never does — a cloned repository could otherwise aim our `Authorization`
   * header at any host it likes and collect the user's token.
   */
  tokenAllowed: boolean;
}

/**
 * Resolve the GitHub API base and decide whether the token may travel to it.
 *
 * Precedence, unchanged from the PRD:
 *   1. an explicitly configured `githubApiUrl` (must be `https:`)
 *   2. otherwise `https://HOST/api/v3` when the remote host is not github.com
 *   3. otherwise the default API
 *
 * Pure so the trust rule is unit-testable without an editor.
 */
export function resolveGitHubApiBase(configured: string, remote: ParsedRemoteUrl | null): GitHubApiBase {
  const value = typeof configured === 'string' ? configured.trim() : '';
  if (value.length > 0 && value !== DEFAULT_GITHUB_API_URL) {
    // Plaintext HTTP would put the token on the wire in the clear.
    if (/^https:\/\//i.test(value)) {
      return { apiUrl: value.replace(/\/+$/, ''), tokenAllowed: true };
    }
    return { apiUrl: DEFAULT_GITHUB_API_URL, tokenAllowed: true };
  }
  if (remote !== null && !remote.isGitHub) {
    return { apiUrl: `https://${remote.host}/api/v3`, tokenAllowed: false };
  }
  return { apiUrl: DEFAULT_GITHUB_API_URL, tokenAllowed: true };
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
 *
 * A backslash terminates the authority and is otherwise treated as a path
 * separator, exactly as the WHATWG URL parser and every browser do. Reading it
 * as an ordinary character instead would attribute
 * `https://evil.example\@github.com/o/r` to `github.com` — the userinfo rule
 * would swallow `evil.example\` — while `new URL()`, `vscode.Uri.parse`, and the
 * browser all resolve `evil.example`. Two parsers disagreeing about the host of
 * one URL is the bug; the UI reports ours.
 */
function splitHostAndPath(value: string): { host: string; path: string } | null {
  const scheme = SCHEMES.find((s) => value.toLowerCase().startsWith(s));
  if (scheme !== undefined) {
    const rest = value.slice(scheme.length);
    const slash = rest.search(/[/\\]/);
    if (slash <= 0) return null;
    const authority = rest.slice(0, slash);
    // Everything before the LAST `@` is userinfo; drop it, secret and all.
    const at = authority.lastIndexOf('@');
    const hostPort = at === -1 ? authority : authority.slice(at + 1);
    const host = stripPort(hostPort);
    if (host === null) return null;
    return { host, path: rest.slice(slash + 1).replace(/\\/g, '/') };
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
