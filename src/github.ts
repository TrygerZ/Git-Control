/**
 * GitHub REST client — metadata only.
 *
 * HARD RULE, restated because it is easy to erode: git push and git fetch ALWAYS
 * go through the Git CLI ({@link GitRunner}). This client never transfers objects
 * and never authenticates a git transport. It reads metadata (viewer, repository,
 * pull requests) so the UI can decorate what git already told us. If a feature
 * needs to move commits, it belongs in `git.ts`, not here.
 *
 * No `vscode` import: the API base, the token, the clock, and even `fetch` are
 * injected, so every rule below (retry, breaker, cache, redaction) is unit-testable
 * without network access.
 *
 * The token is a secret. It is written to exactly one place — the `Authorization`
 * header — and never appears in a log line, an error message, an error `detail`,
 * or any returned value. {@link redact} is applied to everything logged.
 */
import { redact } from './logger';
import type { ErrorCode, GitHubRateLimit, PullRequestInfo } from './messages';

export const GITHUB_MESSAGES = {
  invalidToken: 'Token GitHub tidak valid.',
  notFound: 'Repository GitHub tidak tersedia.',
  unavailable: 'GitHub tidak dapat dijangkau.',
  rateLimited: 'Batas permintaan GitHub tercapai.',
  forbidden: 'Akses GitHub ditolak.',
  scopeMissing: 'Token tidak punya scope repo:status untuk repository privat.',
} as const;

/** Minimum scope for private repositories, per the PRD. */
export const REQUIRED_PRIVATE_SCOPE = 'repo:status';

/** Structured GitHub failure, shaped so the bridge can map it without guessing. */
export class GitHubError extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  readonly detail?: string;
  /** Epoch ms when the rate-limit window resets. Only set for RATE_LIMITED. */
  readonly resetAt?: number;

  constructor(params: {
    status: number;
    code: ErrorCode;
    message: string;
    detail?: string;
    resetAt?: number;
  }) {
    // Redacted defensively: a message built from a response body must never
    // carry a credential even if GitHub echoes one back.
    super(redact(params.message));
    this.name = 'GitHubError';
    this.status = params.status;
    this.code = params.code;
    if (params.detail !== undefined) this.detail = redact(params.detail);
    if (params.resetAt !== undefined) this.resetAt = params.resetAt;
  }
}

export interface ViewerInfo {
  login: string;
  scopes: string[];
}

export interface RepoInfo {
  defaultBranch: string;
  private: boolean;
  htmlUrl: string;
}

/** Minimal `fetch` surface, so a test stub does not have to model all of it. */
export type FetchLike = (url: string, init: FetchInit) => Promise<FetchResponseLike>;

export interface FetchInit {
  method: string;
  headers: Record<string, string>;
  signal?: AbortSignal;
}

export interface FetchResponseLike {
  status: number;
  ok: boolean;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}

export interface GitHubClientOptions {
  /** API base, e.g. `https://api.github.com` or `https://HOST/api/v3`. */
  apiUrl: string;
  /** Personal access token, or `null`/`undefined` for anonymous requests. */
  token?: string | null;
  fetchImpl?: FetchLike;
  now?: () => number;
  logger?: (line: string) => void;
  /** Overridable so tests do not sleep for real. */
  sleep?: (ms: number) => Promise<void>;
}

/** Result envelope: the payload plus whether it came from cache. */
export interface Fetched<T> {
  data: T;
  cached: boolean;
  rateLimit: GitHubRateLimit;
}

const RETRY_DELAYS_MS = [500, 1000, 2000];
const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);
const BREAKER_THRESHOLD = 5;
const BREAKER_WINDOW_MS = 60_000;
const REPO_TTL_MS = 300_000;
const PR_TTL_MS = 60_000;
const VIEWER_TTL_MS = 300_000;
const REQUEST_TIMEOUT_MS = 15_000;

interface CacheEntry {
  at: number;
  value: unknown;
}

export class GitHubClient {
  private readonly apiUrl: string;
  private readonly token: string | null;
  private readonly fetchImpl: FetchLike;
  private readonly now: () => number;
  private readonly logger: (line: string) => void;
  private readonly sleep: (ms: number) => Promise<void>;

  private readonly cache = new Map<string, CacheEntry>();
  /** Timestamps of recent failures, used for the sliding breaker window. */
  private failures: number[] = [];
  private breakerOpen = false;
  private lastRateLimit: { limit: number | null; remaining: number | null; resetAt: number | null } = {
    limit: null,
    remaining: null,
    resetAt: null,
  };

  constructor(options: GitHubClientOptions) {
    this.apiUrl = options.apiUrl.replace(/\/+$/, '');
    this.token = options.token !== undefined && options.token !== null && options.token.length > 0
      ? options.token
      : null;
    this.fetchImpl = options.fetchImpl ?? defaultFetch;
    this.now = options.now ?? ((): number => Date.now());
    this.logger = options.logger ?? ((): void => undefined);
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  get hasToken(): boolean {
    return this.token !== null;
  }

  /** Snapshot for the UI badge. `offline` reflects the breaker, not the network. */
  rateLimit(cached = false): GitHubRateLimit {
    return {
      limit: this.lastRateLimit.limit,
      remaining: this.lastRateLimit.remaining,
      resetAt: this.lastRateLimit.resetAt,
      cached,
      offline: this.breakerOpen,
    };
  }

  get circuitOpen(): boolean {
    return this.breakerOpen;
  }

  /** Drop cached responses. Used when the token changes. */
  clearCache(): void {
    this.cache.clear();
  }

  // ------------------------------------------------------------------ reads

  /**
   * Validate the token and read the login plus granted scopes.
   *
   * Scopes are only available from the `x-oauth-scopes` response header; there is
   * no body field for them, which is why this method exists at all.
   */
  async viewer(): Promise<Fetched<ViewerInfo>> {
    if (this.token === null) {
      throw new GitHubError({ status: 401, code: 'AUTH_ERROR', message: GITHUB_MESSAGES.invalidToken });
    }
    return this.get<ViewerInfo>('/user', 'viewer', VIEWER_TTL_MS, (body, headers) => {
      const json = body as { login?: unknown };
      return {
        login: typeof json.login === 'string' ? json.login : '',
        scopes: parseScopes(headers.get('x-oauth-scopes')),
      };
    });
  }

  async repo(owner: string, repo: string): Promise<Fetched<RepoInfo>> {
    const path = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
    return this.get<RepoInfo>(path, `repo:${owner}/${repo}`, REPO_TTL_MS, (body) => {
      const json = body as { default_branch?: unknown; private?: unknown; html_url?: unknown };
      return {
        defaultBranch: typeof json.default_branch === 'string' ? json.default_branch : '',
        private: json.private === true,
        htmlUrl: typeof json.html_url === 'string' ? json.html_url : '',
      };
    });
  }

  async pullRequests(
    owner: string,
    repo: string,
    opts: { state?: 'open' | 'closed' | 'all'; perPage?: number } = {},
  ): Promise<Fetched<PullRequestInfo[]>> {
    const state = opts.state ?? 'open';
    const perPage = clampPerPage(opts.perPage ?? 50);
    const path =
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls` +
      `?state=${state}&per_page=${perPage}&sort=updated&direction=desc`;
    return this.get<PullRequestInfo[]>(
      path,
      `pulls:${owner}/${repo}:${state}:${perPage}`,
      PR_TTL_MS,
      (body) => toPullRequests(body),
    );
  }

  /**
   * Pull requests that contain a commit. One cheap request against
   * `/commits/{sha}/pulls`, so a graph node can show its PR without a search.
   */
  async pullRequestsForCommit(
    owner: string,
    repo: string,
    hash: string,
  ): Promise<Fetched<PullRequestInfo[]>> {
    const path =
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}` +
      `/commits/${encodeURIComponent(hash)}/pulls`;
    return this.get<PullRequestInfo[]>(path, `commitPulls:${owner}/${repo}:${hash}`, PR_TTL_MS, (body) =>
      toPullRequests(body),
    );
  }

  /**
   * Probe that bypasses the breaker and closes it on success. Nothing else can
   * close the breaker, so an open circuit never quietly resumes hammering a
   * failing API.
   */
  async probe(): Promise<boolean> {
    try {
      await this.send('/rate_limit');
      this.recordSuccess();
      return true;
    } catch {
      return false;
    }
  }

  /** Browsable commit URL. Pure: no request, safe to call for every graph row. */
  commitUrl(owner: string, repo: string, hash: string): string {
    return `${this.webBase()}/${owner}/${repo}/commit/${hash}`;
  }

  /** Web host derived from the API base: `api.github.com` → `github.com`. */
  private webBase(): string {
    const match = /^https?:\/\/([^/]+)(\/.*)?$/.exec(this.apiUrl);
    const host = match?.[1] ?? 'github.com';
    if (host === 'api.github.com') return 'https://github.com';
    return `https://${host}`;
  }

  // --------------------------------------------------------------- internals

  /** Cache-then-network read with breaker, retry, and TTL applied in that order. */
  private async get<T>(
    path: string,
    cacheKey: string,
    ttlMs: number,
    map: (body: unknown, headers: { get(name: string): string | null }) => T,
  ): Promise<Fetched<T>> {
    const fresh = this.readCache<T>(cacheKey, ttlMs);
    if (fresh !== undefined) return { data: fresh, cached: true, rateLimit: this.rateLimit(true) };

    if (this.breakerOpen) {
      // Open circuit: serve any cached copy regardless of age, else fail fast.
      const stale = this.readCache<T>(cacheKey, Number.POSITIVE_INFINITY);
      if (stale !== undefined) return { data: stale, cached: true, rateLimit: this.rateLimit(true) };
      throw new GitHubError({
        status: 503,
        code: 'UNAVAILABLE',
        message: GITHUB_MESSAGES.unavailable,
        detail: 'circuit open',
      });
    }

    const response = await this.send(path);
    const parsed = parseJson(response.body);
    const data = map(parsed, response.headers);
    this.cache.set(cacheKey, { at: this.now(), value: data });
    return { data, cached: false, rateLimit: this.rateLimit(false) };
  }

  /**
   * One request with retries. Retries cover network failures plus 429/502/503/504
   * only: a 4xx that is not 429 is a client mistake and repeating it just burns
   * rate limit.
   */
  private async send(path: string): Promise<{
    body: string;
    headers: { get(name: string): string | null };
  }> {
    let attempt = 0;
    for (;;) {
      try {
        const response = await this.fetchImpl(`${this.apiUrl}${path}`, {
          method: 'GET',
          headers: this.headers(),
        });
        this.readRateLimit(response.headers);
        if (response.status >= 200 && response.status < 300) {
          this.recordSuccess();
          return { body: await response.text(), headers: response.headers };
        }

        const error = await this.toError(response);
        if (RETRYABLE_STATUS.has(response.status) && attempt < RETRY_DELAYS_MS.length) {
          await this.backoff(attempt, path, `status ${response.status}`);
          attempt += 1;
          continue;
        }
        this.recordFailure(response.status >= 500 || response.status === 429);
        throw error;
      } catch (err) {
        if (err instanceof GitHubError) throw err;
        // Transport failure: retryable until the budget is spent.
        if (attempt < RETRY_DELAYS_MS.length) {
          await this.backoff(attempt, path, 'network');
          attempt += 1;
          continue;
        }
        this.recordFailure(true);
        throw new GitHubError({
          status: 503,
          code: 'UNAVAILABLE',
          message: GITHUB_MESSAGES.unavailable,
          detail: messageOf(err),
        });
      }
    }
  }

  private async backoff(attempt: number, path: string, reason: string): Promise<void> {
    const delay = RETRY_DELAYS_MS[attempt] as number;
    this.logger(redact(`github/retry ${path} ${reason} in ${delay}ms`));
    await this.sleep(delay);
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    };
    // The ONLY place the token is used. Anonymous requests still work for public
    // repositories, just with a much smaller rate limit.
    if (this.token !== null) headers.Authorization = `Bearer ${this.token}`;
    return headers;
  }

  /** Map a non-2xx response onto the PRD's code table. */
  private async toError(response: FetchResponseLike): Promise<GitHubError> {
    const remaining = numberOf(response.headers.get('x-ratelimit-remaining'));
    const resetAt = resetAtOf(response.headers.get('x-ratelimit-reset'));

    if (response.status === 401) {
      return new GitHubError({ status: 401, code: 'AUTH_ERROR', message: GITHUB_MESSAGES.invalidToken });
    }
    if (response.status === 404) {
      return new GitHubError({ status: 404, code: 'NOT_FOUND', message: GITHUB_MESSAGES.notFound });
    }
    if ((response.status === 403 || response.status === 429) && remaining === 0) {
      return new GitHubError({
        status: 429,
        code: 'RATE_LIMITED',
        message: GITHUB_MESSAGES.rateLimited,
        ...(resetAt === null ? {} : { resetAt }),
      });
    }
    if (response.status === 403) {
      return new GitHubError({ status: 403, code: 'FORBIDDEN', message: GITHUB_MESSAGES.forbidden });
    }
    if (response.status === 429) {
      return new GitHubError({
        status: 429,
        code: 'RATE_LIMITED',
        message: GITHUB_MESSAGES.rateLimited,
        ...(resetAt === null ? {} : { resetAt }),
      });
    }
    return new GitHubError({
      status: response.status >= 500 ? 503 : response.status,
      code: 'UNAVAILABLE',
      message: GITHUB_MESSAGES.unavailable,
      detail: `status ${response.status}`,
    });
  }

  private readRateLimit(headers: { get(name: string): string | null }): void {
    const limit = numberOf(headers.get('x-ratelimit-limit'));
    const remaining = numberOf(headers.get('x-ratelimit-remaining'));
    const resetAt = resetAtOf(headers.get('x-ratelimit-reset'));
    if (limit !== null) this.lastRateLimit.limit = limit;
    if (remaining !== null) this.lastRateLimit.remaining = remaining;
    if (resetAt !== null) this.lastRateLimit.resetAt = resetAt;
  }

  private readCache<T>(key: string, ttlMs: number): T | undefined {
    const entry = this.cache.get(key);
    if (entry === undefined) return undefined;
    if (this.now() - entry.at > ttlMs) return undefined;
    return entry.value as T;
  }

  private recordSuccess(): void {
    this.failures = [];
    this.breakerOpen = false;
  }

  /** Only server-side and transport failures count toward the breaker. */
  private recordFailure(counts: boolean): void {
    if (!counts) return;
    const now = this.now();
    this.failures = [...this.failures.filter((at) => now - at < BREAKER_WINDOW_MS), now];
    if (this.failures.length >= BREAKER_THRESHOLD) {
      this.breakerOpen = true;
      this.logger('github/breaker open');
    }
  }
}

// ------------------------------------------------------------------ helpers

/** Real `fetch`, adapted to {@link FetchLike} with a hard request timeout. */
const defaultFetch: FetchLike = async (url, init) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return (await fetch(url, { ...init, signal: controller.signal })) as unknown as FetchResponseLike;
  } finally {
    clearTimeout(timer);
  }
};

/** `x-oauth-scopes: repo, read:org` → `['repo', 'read:org']`. */
export function parseScopes(header: string | null): string[] {
  if (header === null) return [];
  return header
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * `true` when the granted scopes cover reading a private repository's status.
 * `repo` implies `repo:status`, so either is enough.
 */
export function hasPrivateScope(scopes: readonly string[]): boolean {
  return scopes.includes('repo') || scopes.includes(REQUIRED_PRIVATE_SCOPE);
}

function toPullRequests(body: unknown): PullRequestInfo[] {
  if (!Array.isArray(body)) return [];
  return body.map((raw) => {
    const pr = raw as {
      number?: unknown;
      title?: unknown;
      state?: unknown;
      html_url?: unknown;
      head?: { ref?: unknown };
      base?: { ref?: unknown };
      draft?: unknown;
      user?: { login?: unknown };
      updated_at?: unknown;
      merged_at?: unknown;
    };
    const merged = typeof pr.merged_at === 'string' && pr.merged_at.length > 0;
    return {
      number: typeof pr.number === 'number' ? pr.number : 0,
      title: typeof pr.title === 'string' ? pr.title : '',
      state: merged ? 'merged' : pr.state === 'closed' ? 'closed' : 'open',
      url: typeof pr.html_url === 'string' ? pr.html_url : '',
      headRef: typeof pr.head?.ref === 'string' ? pr.head.ref : '',
      baseRef: typeof pr.base?.ref === 'string' ? pr.base.ref : '',
      draft: pr.draft === true,
      author: typeof pr.user?.login === 'string' ? pr.user.login : '',
      updatedAt: typeof pr.updated_at === 'string' ? pr.updated_at : '',
    };
  });
}

function parseJson(body: string): unknown {
  if (body.trim().length === 0) return null;
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

function numberOf(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

/** `x-ratelimit-reset` is epoch SECONDS; the UI wants epoch ms. */
function resetAtOf(value: string | null): number | null {
  const seconds = numberOf(value);
  return seconds === null ? null : seconds * 1000;
}

function clampPerPage(value: number): number {
  if (!Number.isFinite(value)) return 50;
  return Math.min(100, Math.max(1, Math.trunc(value)));
}

function messageOf(err: unknown): string {
  return redact(err instanceof Error ? err.message : String(err));
}
