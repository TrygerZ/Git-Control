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
import { randomBytes } from 'node:crypto';
import { redact } from './logger';
import type {
  CheckConclusion,
  CheckRunInfo,
  CheckStatus,
  CommitAuthorInfo,
  ContributorIdentity,
  ErrorCode,
  GitHubRateLimit,
  IssueInfo,
  IssueLabelTone,
  IssueListFilter,
  IssueStateFilter,
  Lang,
  LogLine,
  LogState,
  PullRequestInfo,
  RunConclusion,
  RunJobInfo,
  RunStatus,
  WorkflowInfo,
  WorkflowRunInfo,
} from './messages';
import {
  DEFAULT_LOG_LIMITS,
  DEFAULT_MASKED_TEXT,
  TailBuffer,
  processLog,
  validateLogLocation,
  type LogLimits,
} from './githubLog';
import { hostText } from './hostText';
import { validateHash } from './validation';

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
  /**
   * `null` when the response carried no `x-oauth-scopes` header at all, which is
   * what a fine-grained PAT does: the token type cannot report scopes, so the
   * answer is unknown, not empty. A classic token with nothing granted sends a
   * present-but-empty header, which parses to `[]` and is a real "no".
   */
  scopes: string[] | null;
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
  /** Serialized JSON body. Only the write path sets this; reads never send one. */
  body?: string;
  signal?: AbortSignal;
  /**
   * Manual redirects are required by the log path: hop 1 must see the 302 and
   * read `Location` itself, and hop 2 must never follow a redirect at all.
   */
  redirect?: 'manual' | 'follow' | 'error';
}

export interface FetchResponseLike {
  status: number;
  ok: boolean;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
  /** Streaming body, when the runtime provides one. The log path uses it. */
  body?: {
    getReader(): {
      read(): Promise<{ done: boolean; value?: Uint8Array }>;
      cancel(): Promise<void>;
    };
  } | null;
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
  lang?: () => Lang;
  /**
   * Separate fetch for the log path. Hop 2 uses a whole-exchange timeout instead
   * of the header timer `defaultFetch` clears, so a body that stalls mid-stream
   * still aborts.
   */
  fetchLogImpl?: FetchLike;
}

/** Result envelope: the payload plus whether it came from cache. */
export interface Fetched<T> {
  data: T;
  cached: boolean;
  rateLimit: GitHubRateLimit;
  /** True when the server confirmed the stored copy with a 304. */
  revalidated?: boolean;
}

/** Verbs that change server state. `GET` never reaches {@link GitHubClient.mutate}. */
export type WriteMethod = 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/**
 * One write request. `invalidate` lists cache-key prefixes the write makes
 * stale; `map` turns the response body into the endpoint's DTO.
 */
export interface MutateOptions<T> {
  method: WriteMethod;
  path: string;
  body?: unknown;
  invalidate?: readonly string[];
  map(body: unknown, headers: { get(name: string): string | null }): T;
}

const RETRY_DELAYS_MS = [500, 1000, 2000];
const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);
const BREAKER_THRESHOLD = 5;
const BREAKER_WINDOW_MS = 60_000;
const REPO_TTL_MS = 300_000;
const PR_TTL_MS = 60_000;
export const ISSUES_TTL_MS = 60_000;
/**
 * Workflow runs and jobs answer two questions with one request: what happened,
 * and what is happening now. A run that is still going can change any second, so
 * its copy expires fast; a finished list is history and can live a minute.
 */
export const RUNS_ACTIVE_TTL_MS = 15_000;
export const RUNS_TTL_MS = 60_000;
const WORKFLOWS_TTL_MS = 300_000;
export const JOBS_ACTIVE_TTL_MS = 15_000;
export const JOBS_TTL_MS = 300_000;
/** Check runs move while a push is building, so a commit's checks live 30 s. */
export const CHECK_TTL_MS = 30_000;
const VIEWER_TTL_MS = 300_000;
const AUTHOR_TTL_MS = 300_000;
const REQUEST_TIMEOUT_MS = 15_000;
/**
 * Cap on cached responses. Same bound and same eviction policy as the bridge's
 * idempotency map, for the same reason: an unbounded `Map` in a long-lived
 * extension host is a slow leak.
 */
export const CACHE_MAX_ENTRIES = 200;
export const AUTHOR_CACHE_MAX_ENTRIES = 1000;
export const ETAG_MAX_ENTRIES = 200;
export const AUTHOR_ETAG_MAX_ENTRIES = 1000;
/** Processed tails kept in memory. Small on purpose: each is up to 32 KiB of text. */
export const LOG_CACHE_MAX_ENTRIES = 10;
/** Whole-exchange timeout for hop 2. Signed storage URLs live one minute. */
const LOG_TIMEOUT_MS = 20_000;

/** One job's processed tail plus the count of bytes read (for the host log line). */
export interface ProcessedLog {
  state: LogState;
  lines: LogLine[];
  headCut: boolean;
  bytesRead: number;
}

interface CacheEntry {
  at: number;
  value: unknown;
}

interface EtagEntry {
  etag: string;
  value: unknown;
}

export class GitHubClient {
  private readonly apiUrl: string;
  private readonly token: string | null;
  private readonly fetchImpl: FetchLike;
  private readonly fetchLogImpl: FetchLike;
  private readonly now: () => number;
  private readonly logger: (line: string) => void;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly lang: () => Lang;

  private readonly cache = new Map<string, CacheEntry>();
  private readonly authorCache = new Map<string, CacheEntry>();
  /**
   * Stored validators, keyed by `{tokenFingerprint}|{cacheKey}`.
   *
   * Deliberately separate from `cache`: a body can be evicted while its ETag
   * survives (and vice versa), which is exactly the case the 304-retry path
   * covers. The fingerprint keeps two tokens on one base URL from sharing a
   * validator; ETags are per-URL per the docs and not documented as per-token.
   */
  private readonly etags = new Map<string, EtagEntry>();
  /** Author validators, split and bounded exactly like {@link authorCache}. */
  private readonly authorEtags = new Map<string, EtagEntry>();
  /**
   * Random per-client id, used only to scope validator keys.
   *
   * Not derived from the token: the one property the key needs is that two
   * clients never share a validator, and a random id gives that without putting
   * any token-derived string into a key. `clearCache()` drops the store when the
   * client is rebuilt on a token change.
   */
  private readonly tokenFingerprint: string;
  /** Timestamps of recent failures, used for the sliding breaker window. */
  private failures: number[] = [];
  private breakerOpen = false;
  private lastRateLimit: { limit: number | null; remaining: number | null; resetAt: number | null } = {
    limit: null,
    remaining: null,
    resetAt: null,
  };
  /**
   * Processed tails for completed jobs. Small on purpose: a tail is up to 32 KiB
   * of text, so it is not the 200-entry response cache's business. Logs of a
   * finished job do not change, which is why only completed jobs are cached.
   */
  private readonly logCache = new Map<number, ProcessedLog>();
  private readonly logInFlight = new Map<number, Promise<Fetched<ProcessedLog>>>();
  /** Last `x-poll-interval` seen, in ms. `null` until GitHub sends one. */
  private lastPollIntervalMs: number | null = null;

  constructor(options: GitHubClientOptions) {
    this.apiUrl = options.apiUrl.replace(/\/+$/, '');
    this.token = options.token !== undefined && options.token !== null && options.token.length > 0
      ? options.token
      : null;
    // A per-client random scope, not a digest of the token: the only property the
    // key needs is that two clients never share validators. Deriving it from the
    // token would put a token-derived string in a key for no added benefit, and
    // `clearCache()` already drops everything when the client is rebuilt.
    this.tokenFingerprint = randomBytes(8).toString('hex');
    this.fetchImpl = options.fetchImpl ?? defaultFetch;
    this.fetchLogImpl = options.fetchLogImpl ?? defaultLogFetch;
    this.now = options.now ?? ((): number => Date.now());
    this.logger = options.logger ?? ((): void => undefined);
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.lang = options.lang ?? (() => 'en');
  }

  private text() {
    return hostText(this.lang()).github;
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
      ...(this.lastPollIntervalMs === null ? {} : { pollIntervalMs: this.lastPollIntervalMs }),
    };
  }

  /** Minimum poll interval the server asked for, in ms, or `null` when it never said. */
  get pollIntervalMs(): number | null {
    return this.lastPollIntervalMs;
  }

  get circuitOpen(): boolean {
    return this.breakerOpen;
  }

  /** Number of cached responses. Exposed so the entry cap is testable. */
  get cacheSize(): number {
    return this.cache.size;
  }

  /** Number of cached author responses. */
  get authorCacheSize(): number {
    return this.authorCache.size;
  }

  /** Number of stored list validators. Exposed so the ETag bound is testable. */
  get etagSize(): number {
    return this.etags.size;
  }

  /** Number of stored author validators. */
  get authorEtagSize(): number {
    return this.authorEtags.size;
  }

  /** Drop cached responses. Used when the token changes. */
  clearCache(): void {
    this.cache.clear();
    this.authorCache.clear();
    this.etags.clear();
    this.authorEtags.clear();
    this.logCache.clear();
    this.logInFlight.clear();
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
      throw new GitHubError({ status: 401, code: 'AUTH_ERROR', message: this.text().invalidToken });
    }
    return this.get<ViewerInfo>('/user', 'viewer', VIEWER_TTL_MS, (body, headers) => {
      const json = body as { login?: unknown };
      const raw = headers.get('x-oauth-scopes');
      return {
        login: typeof json.login === 'string' ? json.login : '',
        scopes: raw === null ? null : parseScopes(raw),
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
    opts: { state?: 'open' | 'closed' | 'all'; perPage?: number; refresh?: boolean } = {},
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
      opts.refresh === true ? { refresh: true } : undefined,
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
   * Check runs for a commit, one full page. A commit's checks are only read by
   * the PR list, so the cache key carries the sha and shares the default store.
   */
  async checkRuns(owner: string, repo: string, sha: string): Promise<Fetched<CheckRunInfo[]>> {
    const path =
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}` +
      `/commits/${encodeURIComponent(sha)}/check-runs?per_page=100`;
    return this.get<CheckRunInfo[]>(path, `checks:${owner}/${repo}:${sha}`, CHECK_TTL_MS, (body) =>
      toCheckRuns(body),
    );
  }

  /**
   * Workflow runs, newest first.
   *
   * `workflowId` switches to the per-workflow route. Both routes support the
   * `branch` query.
   */
  async workflowRuns(
    owner: string,
    repo: string,
    opts: { branch?: string; workflowId?: number; perPage?: number } = {},
  ): Promise<Fetched<WorkflowRunInfo[]>> {
    const perPage = clampPerPage(opts.perPage ?? 30);
    const base = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
    const branchPart = opts.branch === undefined ? '' : `&branch=${encodeURIComponent(opts.branch)}`;
    const path =
      opts.workflowId === undefined
        ? `${base}/actions/runs?per_page=${perPage}&exclude_pull_requests=false${branchPart}`
        : `${base}/actions/workflows/${opts.workflowId}/runs?per_page=${perPage}${branchPart}`;
    const key = `runs:${owner}/${repo}:${opts.branch ?? '*'}:${opts.workflowId ?? '*'}:${perPage}`;
    // The TTL depends on what is cached, not on the request: a list with a run
    // still going is stale in seconds, a finished one is history.
    const cached = this.readAny<WorkflowRunInfo[]>(key);
    const ttl = cached !== undefined && runsActive(cached) ? RUNS_ACTIVE_TTL_MS : RUNS_TTL_MS;
    return this.get<WorkflowRunInfo[]>(path, key, ttl, (body) => toWorkflowRuns(body));
  }

  async workflows(owner: string, repo: string): Promise<Fetched<WorkflowInfo[]>> {
    const path =
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}` +
      `/actions/workflows?per_page=100`;
    return this.get<WorkflowInfo[]>(path, `workflows:${owner}/${repo}`, WORKFLOWS_TTL_MS, (body) =>
      toWorkflows(body),
    );
  }

  async runJobs(owner: string, repo: string, runId: number): Promise<Fetched<RunJobInfo[]>> {
    const path =
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}` +
      `/actions/runs/${runId}/jobs?filter=latest&per_page=100`;
    const key = `jobs:${owner}/${repo}:${runId}`;
    const cached = this.readAny<RunJobInfo[]>(key);
    const ttl = cached !== undefined && jobsActive(cached) ? JOBS_ACTIVE_TTL_MS : JOBS_TTL_MS;
    return this.get<RunJobInfo[]>(path, key, ttl, (body) => toJobs(body));
  }

  async issues(
    owner: string,
    repo: string,
    opts: { filter: IssueListFilter; state: IssueStateFilter; login: string | null; perPage?: number },
  ): Promise<Fetched<IssueInfo[]>> {
    if (opts.login === null || opts.login === undefined || opts.login.trim().length === 0) {
      throw new GitHubError({ status: 401, code: 'AUTH_ERROR', message: this.text().invalidToken });
    }
    const state = opts.state ?? 'open';
    const perPage = clampPerPage(opts.perPage ?? 50);
    let filterParam = '';
    if (opts.filter === 'assigned') {
      filterParam = `&assignee=${encodeURIComponent(opts.login)}`;
    } else if (opts.filter === 'created') {
      filterParam = `&creator=${encodeURIComponent(opts.login)}`;
    } else if (opts.filter === 'mentioned') {
      filterParam = `&mentioned=${encodeURIComponent(opts.login)}`;
    }
    const path =
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues` +
      `?state=${state}&per_page=${perPage}&sort=updated&direction=desc${filterParam}`;
    return this.get<IssueInfo[]>(
      path,
      `issues:${owner}/${repo}:${opts.filter}:${state}:${perPage}:${opts.login}`,
      ISSUES_TTL_MS,
      (body) => toIssues(body),
    );
  }

  /**
   * Commit authors and avatars for a batch of commit hashes.
   *
   * Queries `GET /repos/{owner}/{repo}/commits/{sha}` per unique hash. Cached per-hash
   * under `commitAuthor:{owner}/{repo}:{hash}` with 5-minute TTL.
   * Failures for individual hashes degrade gracefully to `login: null, avatarUrl: null`
   * without failing the whole batch.
   */
  async commitAuthors(
    owner: string,
    repo: string,
    hashes: string[],
  ): Promise<Fetched<CommitAuthorInfo[]>> {
    if (hashes.length > 50) {
      throw new GitHubError({
        status: 400,
        code: 'VALIDATION_ERROR',
        message: this.text().invalidHash,
        detail: 'hashes batch size exceeds 50',
      });
    }

    for (const hash of hashes) {
      if (!validateHash(hash)) {
        throw new GitHubError({
          status: 400,
          code: 'VALIDATION_ERROR',
          message: this.text().invalidHash,
          detail: `invalid hash: ${hash}`,
        });
      }
    }

    let allCached = true;
    const authors: CommitAuthorInfo[] = new Array(hashes.length);

    // ponytail: Concurrency cap of 6 to prevent connection starvation / socket exhaustion.
    const CONCURRENCY = 6;
    const fetchAuthor = async (hash: string, index: number): Promise<void> => {
      const path =
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}` +
        `/commits/${encodeURIComponent(hash)}`;
      try {
        const fetched = await this.get<{ login: string | null; avatarUrl: string | null }>(
          path,
          `commitAuthor:${owner}/${repo}:${hash}`,
          AUTHOR_TTL_MS,
          (body) => {
            const json = body as { author?: { login?: unknown; avatar_url?: unknown } | null };
            const author = json.author;
            let avatarUrl: string | null = null;
            if (typeof author?.avatar_url === 'string') {
              try {
                const parsedUrl = new URL(author.avatar_url);
                parsedUrl.searchParams.set('s', '64');
                avatarUrl = parsedUrl.toString();
              } catch {
                avatarUrl = author.avatar_url;
              }
            }
            return {
              login: typeof author?.login === 'string' ? author.login : null,
              avatarUrl,
            };
          },
        );
        if (!fetched.cached) allCached = false;
        authors[index] = {
          hash,
          login: fetched.data.login,
          avatarUrl: fetched.data.avatarUrl,
        };
      } catch {
        authors[index] = { hash, login: null, avatarUrl: null };
      }
    };

    for (let i = 0; i < hashes.length; i += CONCURRENCY) {
      const slice = hashes.slice(i, i + CONCURRENCY);
      await Promise.all(slice.map((h, idx) => fetchAuthor(h, i + idx)));
    }

    return {
      data: authors,
      cached: hashes.length === 0 ? false : allCached,
      rateLimit: this.rateLimit(allCached),
    };
  }

  /**
   * Contributor identity (login, avatar, and profile URL) for an author email.
   *
   * Queries `GET /repos/{owner}/{repo}/commits?author={email}&per_page=1`.
   * Cached per email under `contributorId:{owner}/{repo}:{email}` with 5-minute TTL.
   * Failures degrade gracefully to `login: null, avatarUrl: null, htmlUrl: null`.
   */
  async contributorIdentity(
    owner: string,
    repo: string,
    email: string,
  ): Promise<Fetched<ContributorIdentity>> {
    const trimmed = email.trim();
    if (trimmed.length === 0) {
      return {
        data: { login: null, avatarUrl: null, htmlUrl: null },
        cached: false,
        rateLimit: this.rateLimit(false),
      };
    }

    const params = new URLSearchParams({
      author: trimmed,
      per_page: '1',
    });
    const path =
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits` +
      `?${params.toString()}`;

    try {
      return await this.get<ContributorIdentity>(
        path,
        `contributorId:${owner}/${repo}:${trimmed}`,
        AUTHOR_TTL_MS,
        (body) => {
          if (!Array.isArray(body) || body.length === 0) {
            return { login: null, avatarUrl: null, htmlUrl: null };
          }
          const first = body[0] as
            | { author?: { login?: unknown; avatar_url?: unknown; html_url?: unknown } | null }
            | undefined;
          const author = first?.author;
          let avatarUrl: string | null = null;
          if (typeof author?.avatar_url === 'string') {
            try {
              const parsedUrl = new URL(author.avatar_url);
              parsedUrl.searchParams.set('s', '64');
              avatarUrl = parsedUrl.toString();
            } catch {
              avatarUrl = author.avatar_url;
            }
          }
          return {
            login: typeof author?.login === 'string' ? author.login : null,
            avatarUrl,
            htmlUrl: typeof author?.html_url === 'string' ? author.html_url : null,
          };
        },
      );
    } catch {
      return {
        data: { login: null, avatarUrl: null, htmlUrl: null },
        cached: false,
        rateLimit: this.rateLimit(false),
      };
    }
  }

  /**
   * Processed tail of one job log.
   *
   * Two hops. Hop 1 is the normal authenticated API call, with manual redirects
   * so the signed `Location` can be inspected before it is used. Hop 2 is a
   * plain GET to the signed storage URL with an empty header set: the token
   * must never reach a storage host, and a signed URL already authorizes the
   * read by itself. The URL stays inside this method; the result carries lines
   * only.
   *
   * `blocked` is a result, not an error: the log exists, the host is untrusted,
   * and the UI's remedy is `Open full log`.
   */
  async jobLogTail(
    owner: string,
    repo: string,
    jobId: number,
    opts: { completed?: boolean; limits?: Partial<LogLimits>; maskedText?: string } = {},
  ): Promise<Fetched<ProcessedLog>> {
    const cached = this.logCache.get(jobId);
    if (cached !== undefined) {
      return { data: cached, cached: true, rateLimit: this.rateLimit(true) };
    }
    const inFlight = this.logInFlight.get(jobId);
    if (inFlight !== undefined) return inFlight;

    if (this.breakerOpen) {
      throw new GitHubError({
        status: 503,
        code: 'UNAVAILABLE',
        message: this.text().unavailable,
        detail: 'circuit open',
      });
    }

    const promise = this.fetchJobLog(owner, repo, jobId, opts);
    this.logInFlight.set(jobId, promise);
    try {
      return await promise;
    } finally {
      this.logInFlight.delete(jobId);
    }
  }

  private async fetchJobLog(
    owner: string,
    repo: string,
    jobId: number,
    opts: { completed?: boolean; limits?: Partial<LogLimits>; maskedText?: string },
  ): Promise<Fetched<ProcessedLog>> {
    const limits: LogLimits = { ...DEFAULT_LOG_LIMITS, ...(opts.limits ?? {}) };
    const maskedText = opts.maskedText ?? DEFAULT_MASKED_TEXT;
    const path =
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/jobs/${jobId}/logs`;
    const first = await this.sendOnce(path);
    const remaining = this.rateLimit(false);

    if (first.status === 404 || first.status === 410) {
      return this.finishLog(jobId, { state: 'expired', lines: [], headCut: false, bytesRead: 0 }, false, remaining);
    }
    if (first.status === 401) {
      throw new GitHubError({ status: 401, code: 'AUTH_ERROR', message: this.text().invalidToken });
    }
    if (first.status === 403 || first.status === 429) {
      throw await this.toError(first);
    }

    if (first.status === 200) {
      // GitHub Enterprise Server may answer with the text directly.
      const text = await first.text();
      const processed = this.consume(text, limits, maskedText);
      return this.finishLog(jobId, processed, opts.completed === true, remaining);
    }

    if (first.status !== 301 && first.status !== 302 && first.status !== 307) {
      throw new GitHubError({
        status: 503,
        code: 'UNAVAILABLE',
        message: this.text().unavailable,
        detail: `status ${first.status}`,
      });
    }

    const location = first.headers.get('location');
    if (location === null || location.length === 0) {
      throw new GitHubError({
        status: 503,
        code: 'UNAVAILABLE',
        message: this.text().unavailable,
        detail: 'redirect without location',
      });
    }
    const target = validateLogLocation(location, this.apiUrl);
    if (target === null) {
      return this.finishLog(jobId, { state: 'blocked', lines: [], headCut: false, bytesRead: 0 }, false, remaining);
    }

    // Hop 2: no token, no GitHub headers, manual redirect, whole-exchange timeout.
    let second: FetchResponseLike;
    try {
      second = await this.fetchLogImpl(target.toString(), {
        method: 'GET',
        headers: {},
        redirect: 'manual',
        signal: AbortSignal.timeout(LOG_TIMEOUT_MS),
      });
    } catch (err) {
      // A transport failure here says nothing about the API's health, so it
      // never counts toward the breaker. The message is redacted like any other.
      throw new GitHubError({
        status: 503,
        code: 'UNAVAILABLE',
        message: this.text().unavailable,
        detail: messageOf(err),
      });
    }

    if (second.status === 403 || second.status === 404 || second.status === 410 || (second.status >= 300 && second.status < 400)) {
      // A redirect on hop 2 is refused, and 403/404/410 mean the signed URL has
      // expired or the read is no longer allowed. Both read as `expired`.
      return this.finishLog(jobId, { state: 'expired', lines: [], headCut: false, bytesRead: 0 }, false, remaining);
    }
    if (second.status < 200 || second.status >= 300) {
      // Any other failure is the storage host misbehaving, not a missing log.
      // Saying "expired" here would tell the user to stop trying.
      throw new GitHubError({
        status: 503,
        code: 'UNAVAILABLE',
        message: this.text().unavailable,
        detail: `storage status ${second.status}`,
      });
    }

    const processed = await this.consumeStream(second, limits, maskedText);
    return this.finishLog(jobId, processed, opts.completed === true, remaining);
  }

  /** Cache a finished tail only for a completed job; a running log still changes. */
  private finishLog(
    jobId: number,
    data: ProcessedLog,
    cache: boolean,
    rateLimit: GitHubRateLimit,
  ): Fetched<ProcessedLog> {
    if (cache && data.state !== 'expired' && data.state !== 'blocked') {
      this.logCache.delete(jobId);
      this.logCache.set(jobId, data);
      while (this.logCache.size > LOG_CACHE_MAX_ENTRIES) {
        const oldest = this.logCache.keys().next();
        if (oldest.done === true) break;
        this.logCache.delete(oldest.value);
      }
    }
    return { data, cached: false, rateLimit };
  }

  /** Body already in memory (hop 1 answered 200). */
  private consume(text: string, limits: LogLimits, maskedText: string): ProcessedLog {
    const bytes = new TextEncoder().encode(text);
    const buffer = new TailBuffer(limits);
    const status = buffer.push(bytes);
    const processed = processLog(
      { bytes: buffer.bytes(), headDropped: buffer.headDropped, pemOpen: buffer.pemOpen },
      limits,
      maskedText,
    );
    return {
      state: status === 'overflow' ? 'tooLarge' : processed.state,
      lines: status === 'overflow' ? [] : processed.lines,
      headCut: processed.headCut,
      bytesRead: bytes.length,
    };
  }

  /**
   * Stream hop 2 into the rolling buffer.
   *
   * The reader is cancelled the moment the hard cap is crossed, so an oversized
   * log costs bandwidth up to the cap and no more. A runtime without a streaming
   * body falls back to `text()`, bounded by the same cap check after the fact.
   */
  private async consumeStream(
    response: FetchResponseLike,
    limits: LogLimits,
    maskedText: string,
  ): Promise<ProcessedLog> {
    const body = response.body;
    if (body === undefined || body === null) {
      return this.consume(await response.text(), limits, maskedText);
    }
    const buffer = new TailBuffer(limits);
    const reader = body.getReader();
    for (;;) {
      const step = await reader.read();
      if (step.done) break;
      const chunk = step.value;
      if (chunk === undefined || chunk.length === 0) continue;
      if (buffer.push(chunk) === 'overflow') {
        await reader.cancel();
        return { state: 'tooLarge', lines: [], headCut: false, bytesRead: buffer.total };
      }
    }
    const processed = processLog(
      { bytes: buffer.bytes(), headDropped: buffer.headDropped, pemOpen: buffer.pemOpen },
      limits,
      maskedText,
    );
    return { ...processed, bytesRead: buffer.total };
  }

  /**
   * One request, no retry loop. Used by the log path where a retry would spend
   * another rate-limit unit for a read the user can repeat by hand.
   */
  private async sendOnce(path: string): Promise<FetchResponseLike> {
    let response: FetchResponseLike;
    try {
      response = await this.fetchImpl(`${this.apiUrl}${path}`, {
        method: 'GET',
        headers: this.headers(),
        redirect: 'manual',
      });
    } catch (err) {
      this.recordFailure(true);
      throw new GitHubError({
        status: 503,
        code: 'UNAVAILABLE',
        message: this.text().unavailable,
        detail: messageOf(err),
      });
    }
    this.readRateLimit(response.headers);
    if (response.status >= 200 && response.status < 300) this.recordSuccess();
    if (response.status >= 500) this.recordFailure(true);
    return response;
  }

  // ----------------------------------------------------------------- writes

  /**
   * One write request. Exactly one attempt, always.
   *
   * A write is not idempotent: a retried `POST` can open a second pull request
   * or post a second comment, so the retry ladder of {@link send} is wrong here
   * even for 429/502/503/504 and transport failures. The user repeats the
   * action explicitly. For the same reason there is no stale-cache fallback:
   * serving a cached read while offline is safe, pretending a write landed is
   * not. GitHub REST has no `Idempotency-Key`, so no such header is sent.
   */
  private async mutate<T>(options: MutateOptions<T>): Promise<{ data: T; rateLimit: GitHubRateLimit }> {
    if (this.breakerOpen) {
      throw new GitHubError({
        status: 503,
        code: 'UNAVAILABLE',
        message: this.text().unavailable,
        detail: 'circuit open',
      });
    }

    const headers = this.headers();
    const init: FetchInit = { method: options.method, headers };
    if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(options.body);
    }

    let response: FetchResponseLike;
    this.logger(redact(`github/write ${options.method} ${options.path}`));
    try {
      response = await this.fetchImpl(`${this.apiUrl}${options.path}`, init);
    } catch (err) {
      this.recordFailure(true);
      throw new GitHubError({
        status: 503,
        code: 'UNAVAILABLE',
        message: this.text().unavailable,
        detail: messageOf(err),
      });
    }

    this.readRateLimit(response.headers);

    if (response.status >= 200 && response.status < 300) {
      this.recordSuccess();
      // The write landed. Drop the stale cache before touching the body: a
      // connection that dies mid-read must not leave a pre-write list behind.
      this.invalidate(options.invalidate ?? []);
      try {
        const parsed = parseJson(await response.text());
        return { data: options.map(parsed, response.headers), rateLimit: this.rateLimit(false) };
      } catch (err) {
        if (err instanceof GitHubError) throw err;
        // The write already committed on GitHub's side. Reporting a raw error
        // would map to 500 SERVER_ERROR and invite a duplicate POST, so say
        // plainly that the outcome is unknown.
        throw new GitHubError({
          status: 503,
          code: 'UNAVAILABLE',
          message: this.text().unavailable,
          detail: messageOf(err),
        });
      }
    }

    // Write-only mappings, kept together. A 422 was understood and refused: a
    // client mistake, not an outage. A non-quota 403 means the token lacks a
    // permission, and a write knows which one it needed, so name it. The read
    // path keeps `text.forbidden` because a read has no scope to name.
    let error: GitHubError;
    if (response.status === 422) {
      error = new GitHubError({ status: 422, code: 'VALIDATION_ERROR', message: this.text().invalidWrite });
    } else if (response.status === 403 && numberOf(response.headers.get('x-ratelimit-remaining')) !== 0) {
      error = new GitHubError({ status: 403, code: 'FORBIDDEN', message: this.text().missingScope('repo') });
    } else {
      // Quota 403/429 and every other status keep the read mapping.
      error = await this.toError(response);
    }
    this.recordFailure(response.status >= 500 || response.status === 429);
    throw error;
  }

  /**
   * Drop every cached response whose key starts with one of `prefixes`.
   *
   * Both response stores (`cache` and `authorCache`) and both validator stores
   * are swept, and the validator sweep is independent of the body sweep: they
   * are bounded separately (`ETAG_MAX_ENTRIES` vs `CACHE_MAX_ENTRIES`) and
   * desync as soon as one 200 carries no ETag, so a key present in one says
   * nothing about the other. A surviving validator would answer the next read
   * with a 304 and re-serve the pre-write body.
   *
   * Returns the total number of body entries removed across both stores.
   */
  invalidate(prefixes: readonly string[]): number {
    let removed = 0;
    for (const store of [this.cache, this.authorCache]) {
      for (const key of [...store.keys()]) {
        if (!prefixes.some((prefix) => key.startsWith(prefix))) continue;
        store.delete(key);
        removed += 1;
      }
    }
    const salt = `${this.tokenFingerprint}|`;
    for (const store of [this.etags, this.authorEtags]) {
      for (const key of [...store.keys()]) {
        const cacheKey = key.startsWith(salt) ? key.slice(salt.length) : key;
        if (prefixes.some((prefix) => cacheKey.startsWith(prefix))) store.delete(key);
      }
    }
    return removed;
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

  /**
   * Cache-then-network read with breaker, retry, and TTL applied in that order.
   *
   * `refresh` skips the fresh-cache return but still sends the stored validator,
   * so a manual Reload costs one conditional request instead of a full payload.
   */
  private async get<T>(
    path: string,
    cacheKey: string,
    ttlMs: number,
    map: (body: unknown, headers: { get(name: string): string | null }) => T,
    opts?: { refresh?: boolean },
  ): Promise<Fetched<T>> {
    if (opts?.refresh !== true) {
      const fresh = this.readCache<T>(cacheKey, ttlMs);
      if (fresh !== undefined) return { data: fresh, cached: true, rateLimit: this.rateLimit(true) };
    }

    if (this.breakerOpen) {
      // Open circuit: serve any cached copy regardless of age, else fail fast.
      const stale = this.readCache<T>(cacheKey, Number.POSITIVE_INFINITY);
      if (stale !== undefined) return { data: stale, cached: true, rateLimit: this.rateLimit(true) };
      throw new GitHubError({
        status: 503,
        code: 'UNAVAILABLE',
        message: this.text().unavailable,
        detail: 'circuit open',
      });
    }

    const etagKey = `${this.tokenFingerprint}|${cacheKey}`;
    const store = this.etagStore(cacheKey);
    const stored = store.get(etagKey);
    let response = await this.send(path, stored === undefined ? undefined : { etag: stored.etag });

    // A 304 is only answerable while the stored validator is still here. It can
    // vanish mid-flight when a concurrent read evicts it at the bound, so re-read
    // rather than trust the pre-request lookup. One unconditional retry, no loop.
    if (response.status === 304 && !store.has(etagKey)) {
      response = await this.send(path);
      if (response.status === 304) {
        throw new GitHubError({
          status: 503,
          code: 'UNAVAILABLE',
          message: this.text().unavailable,
          detail: 'status 304 without a conditional request',
        });
      }
    }

    if (response.status === 304) {
      const entry = store.get(etagKey) as EtagEntry;
      // Re-insert through `setEtag` so the refreshed key moves to the end of the
      // eviction order. Mutating `at` in place would leave a key that is being
      // revalidated every few seconds as the next eviction candidate.
      this.setEtag(cacheKey, etagKey, { etag: entry.etag, value: entry.value });
      this.setCache(cacheKey, entry.value);
      return {
        data: entry.value as T,
        cached: false,
        rateLimit: this.rateLimit(false),
        revalidated: true,
      };
    }

    const parsed = parseJson(response.body);
    const data = map(parsed, response.headers);
    this.setCache(cacheKey, data);
    const etag = response.headers.get('etag');
    if (etag !== null && etag.length > 0) {
      this.setEtag(cacheKey, etagKey, { etag, value: data });
    } else {
      // A 200 that carries no validator invalidates the one we held: keeping it
      // would pair an old etag with a new value, and the next 304 would answer
      // from the old value and re-cache it, silently reverting the list.
      store.delete(etagKey);
    }
    return { data, cached: false, rateLimit: this.rateLimit(false) };
  }

  /**
   * Store a validator, evicting the oldest past its bound.
   *
   * The author/non-author split mirrors {@link setCache} and exists for the same
   * reason: `commitAuthor:` and `contributorId:` keys grow one per commit
   * inspected, and both webviews share one client, so a graph scroll would
   * otherwise evict the pull request list's validator and silently turn Reload
   * back into a full read. Insertion-order eviction, same as the response cache.
   */
  private setEtag(cacheKey: string, key: string, entry: { etag: string; value: unknown }): void {
    const isAuthor = isAuthorKey(cacheKey);
    const target = isAuthor ? this.authorEtags : this.etags;
    const maxEntries = isAuthor ? AUTHOR_ETAG_MAX_ENTRIES : ETAG_MAX_ENTRIES;

    target.delete(key);
    target.set(key, { etag: entry.etag, value: entry.value });
    while (target.size > maxEntries) {
      const oldest = target.keys().next();
      if (oldest.done === true) break;
      target.delete(oldest.value);
    }
  }

  /** The store a key belongs to. Routed on the cache key, never the salted one. */
  private etagStore(cacheKey: string): Map<string, EtagEntry> {
    return isAuthorKey(cacheKey) ? this.authorEtags : this.etags;
  }

  /**
   * Store a response, evicting the oldest entries past {@link CACHE_MAX_ENTRIES}.
   *
   * The TTL alone does not bound the map: it is applied on *read*, so a stale entry
   * is not returned but is also not removed — and the breaker path deliberately
   * reads with an infinite TTL to serve stale data while GitHub is unreachable, so
   * entries have to survive expiry. Most keys are fixed per repository, but
   * `commitPulls:` grows one entry per commit inspected, up to the 10 000-commit
   * ceiling. Insertion-order eviction, matching the idempotency map in `bridge.ts`.
   */
  private setCache(key: string, value: unknown): void {
    const isAuthor = key.startsWith('commitAuthor:') || key.startsWith('contributorId:');
    const targetCache = isAuthor ? this.authorCache : this.cache;
    const maxEntries = isAuthor ? AUTHOR_CACHE_MAX_ENTRIES : CACHE_MAX_ENTRIES;

    // Re-inserting moves the key to the end, so a refreshed entry is not the
    // eviction candidate merely because it was first seen long ago.
    targetCache.delete(key);
    targetCache.set(key, { at: this.now(), value });
    while (targetCache.size > maxEntries) {
      const oldest = targetCache.keys().next();
      if (oldest.done === true) break;
      targetCache.delete(oldest.value);
    }
  }

  /**
   * One request with retries. Retries cover network failures plus 429/502/503/504
   * only: a 4xx that is not 429 is a client mistake and repeating it just burns
   * rate limit.
   *
   * A 304 is returned as a normal result, never routed through {@link toError}:
   * it means "your copy is current", and counting it as a failure would open the
   * breaker for a client that is behaving exactly right.
   */
  private async send(
    path: string,
    opts?: { etag?: string },
  ): Promise<{ status: number; body: string; headers: { get(name: string): string | null } }> {
    let attempt = 0;
    for (;;) {
      try {
        const headers = this.headers();
        if (opts?.etag !== undefined) headers['If-None-Match'] = opts.etag;
        const response = await this.fetchImpl(`${this.apiUrl}${path}`, { method: 'GET', headers });
        this.readRateLimit(response.headers);
        if (response.status === 304) {
          this.recordSuccess();
          return { status: 304, body: '', headers: response.headers };
        }
        if (response.status >= 200 && response.status < 300) {
          this.recordSuccess();
          return { status: response.status, body: await response.text(), headers: response.headers };
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
          message: this.text().unavailable,
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
    const text = this.text();

    if (response.status === 401) {
      return new GitHubError({ status: 401, code: 'AUTH_ERROR', message: text.invalidToken });
    }
    if (response.status === 404) {
      return new GitHubError({ status: 404, code: 'NOT_FOUND', message: text.notFound });
    }
    if ((response.status === 403 || response.status === 429) && remaining === 0) {
      return new GitHubError({
        status: 429,
        code: 'RATE_LIMITED',
        message: text.rateLimited,
        ...(resetAt === null ? {} : { resetAt }),
      });
    }
    if (response.status === 403) {
      return new GitHubError({ status: 403, code: 'FORBIDDEN', message: text.forbidden });
    }
    if (response.status === 429) {
      return new GitHubError({
        status: 429,
        code: 'RATE_LIMITED',
        message: text.rateLimited,
        ...(resetAt === null ? {} : { resetAt }),
      });
    }
    return new GitHubError({
      status: response.status >= 500 ? 503 : response.status,
      code: 'UNAVAILABLE',
      message: text.unavailable,
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
    // `x-poll-interval` is seconds; the scheduler works in ms. Only GitHub's
    // polling endpoints send it, so it stays null everywhere else.
    const pollSeconds = numberOf(headers.get('x-poll-interval'));
    if (pollSeconds !== null && pollSeconds >= 0) this.lastPollIntervalMs = pollSeconds * 1000;
  }

  /** Cached value regardless of age, for callers that pick their own TTL. */
  private readAny<T>(key: string): T | undefined {
    const isAuthor = key.startsWith('commitAuthor:') || key.startsWith('contributorId:');
    const targetCache = isAuthor ? this.authorCache : this.cache;
    return targetCache.get(key)?.value as T | undefined;
  }

  private readCache<T>(key: string, ttlMs: number): T | undefined {
    const isAuthor = key.startsWith('commitAuthor:') || key.startsWith('contributorId:');
    const targetCache = isAuthor ? this.authorCache : this.cache;
    const entry = targetCache.get(key);
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

/**
 * Fetch for the log second hop: one whole-exchange timeout instead of the header
 * timer `defaultFetch` clears. The body is streamed, so a stall mid-body has to
 * abort too, and `AbortSignal.timeout` keeps ticking until the body is consumed.
 */
const defaultLogFetch: FetchLike = async (url, init) => {
  return (await fetch(url, { ...init, signal: init.signal })) as unknown as FetchResponseLike;
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

// ------------------------------------------------------------------ actions

const RUN_STATUSES: ReadonlySet<string> = new Set([
  'queued',
  'in_progress',
  'completed',
  'waiting',
  'requested',
  'pending',
]);

const RUN_CONCLUSIONS: ReadonlySet<string> = new Set([
  'success',
  'failure',
  'cancelled',
  'skipped',
  'timed_out',
  'neutral',
  'action_required',
  'stale',
  'startup_failure',
]);

/** A status the UI does not know is not a completed run, so it maps to `pending`. */
function toRunStatus(value: unknown): RunStatus {
  return typeof value === 'string' && RUN_STATUSES.has(value) ? (value as RunStatus) : 'pending';
}

function toRunConclusion(value: unknown): RunConclusion {
  return typeof value === 'string' && RUN_CONCLUSIONS.has(value) ? (value as RunConclusion) : null;
}

const CHECK_CONCLUSIONS: ReadonlySet<string> = new Set([
  'success',
  'failure',
  'neutral',
  'cancelled',
  'skipped',
  'timed_out',
  'action_required',
  'stale',
]);

/** Only the two terminal-ish states survive; `requested`, `waiting`, junk are queued. */
function toCheckStatus(value: unknown): CheckStatus {
  return value === 'completed' || value === 'in_progress' ? value : 'queued';
}

function toCheckConclusion(value: unknown): CheckConclusion {
  return typeof value === 'string' && CHECK_CONCLUSIONS.has(value) ? (value as CheckConclusion) : null;
}

export function toCheckRuns(body: unknown): CheckRunInfo[] {
  const list = (body as { check_runs?: unknown } | null)?.check_runs;
  if (!Array.isArray(list)) return [];
  return list.map((raw) => {
    const run = raw as {
      id?: unknown;
      name?: unknown;
      status?: unknown;
      conclusion?: unknown;
      html_url?: unknown;
      started_at?: unknown;
      completed_at?: unknown;
    };
    return {
      id: typeof run.id === 'number' ? run.id : 0,
      name: typeof run.name === 'string' ? run.name : '',
      status: toCheckStatus(run.status),
      conclusion: toCheckConclusion(run.conclusion),
      url: typeof run.html_url === 'string' ? run.html_url : '',
      startedAt: isoOrNull(run.started_at),
      completedAt: isoOrNull(run.completed_at),
    };
  });
}

/**
 * Only `https:` links survive. Everything else becomes an empty string, which the
 * view reads as "no link", so a crafted `javascript:` URL cannot reach a click.
 */
function httpsUrl(value: unknown): string {
  return typeof value === 'string' && value.startsWith('https://') ? value : '';
}

/** A count that could have come from JSON. Out-of-range values become `fallback`. */
function safeInt(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

function isoOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function isoOrEmpty(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export function toWorkflowRuns(body: unknown): WorkflowRunInfo[] {
  const list = (body as { workflow_runs?: unknown } | null)?.workflow_runs;
  if (!Array.isArray(list)) return [];
  return list.map((raw) => {
    const run = raw as {
      id?: unknown;
      workflow_id?: unknown;
      name?: unknown;
      display_title?: unknown;
      run_number?: unknown;
      event?: unknown;
      status?: unknown;
      conclusion?: unknown;
      head_branch?: unknown;
      head_sha?: unknown;
      html_url?: unknown;
      created_at?: unknown;
      run_started_at?: unknown;
      updated_at?: unknown;
      run_attempt?: unknown;
    };
    return {
      id: safeInt(run.id),
      workflowId: safeInt(run.workflow_id),
      name: typeof run.name === 'string' ? run.name : '',
      title: typeof run.display_title === 'string' ? run.display_title : '',
      runNumber: safeInt(run.run_number),
      event: typeof run.event === 'string' ? run.event : '',
      status: toRunStatus(run.status),
      conclusion: toRunConclusion(run.conclusion),
      branch: typeof run.head_branch === 'string' && run.head_branch.length > 0 ? run.head_branch : null,
      sha: typeof run.head_sha === 'string' ? run.head_sha : '',
      url: httpsUrl(run.html_url),
      createdAt: isoOrEmpty(run.created_at),
      startedAt: isoOrNull(run.run_started_at),
      updatedAt: isoOrEmpty(run.updated_at),
      attempt: safeInt(run.run_attempt, 1) || 1,
    };
  });
}

export function toWorkflows(body: unknown): WorkflowInfo[] {
  const list = (body as { workflows?: unknown } | null)?.workflows;
  if (!Array.isArray(list)) return [];
  return list.map((raw) => {
    const wf = raw as { id?: unknown; name?: unknown; path?: unknown; state?: unknown };
    return {
      id: safeInt(wf.id),
      name: typeof wf.name === 'string' ? wf.name : '',
      path: typeof wf.path === 'string' ? wf.path : '',
      state: typeof wf.state === 'string' ? wf.state : '',
    };
  });
}

export function toJobs(body: unknown): RunJobInfo[] {
  const list = (body as { jobs?: unknown } | null)?.jobs;
  if (!Array.isArray(list)) return [];
  return list.map((raw) => {
    const job = raw as {
      id?: unknown;
      name?: unknown;
      status?: unknown;
      conclusion?: unknown;
      started_at?: unknown;
      completed_at?: unknown;
      html_url?: unknown;
      steps?: unknown;
    };
    return {
      id: safeInt(job.id),
      name: typeof job.name === 'string' ? job.name : '',
      status: toRunStatus(job.status),
      conclusion: toRunConclusion(job.conclusion),
      startedAt: isoOrNull(job.started_at),
      completedAt: isoOrNull(job.completed_at),
      url: httpsUrl(job.html_url),
      steps: Array.isArray(job.steps)
        ? job.steps.map((rawStep) => {
            const step = rawStep as {
              number?: unknown;
              name?: unknown;
              status?: unknown;
              conclusion?: unknown;
            };
            return {
              number: safeInt(step.number),
              name: typeof step.name === 'string' ? step.name : '',
              status: typeof step.status === 'string' ? step.status : '',
              conclusion: typeof step.conclusion === 'string' ? step.conclusion : null,
            };
          })
        : [],
    };
  });
}

/** True while any run can still change without a user action. */
function runsActive(runs: readonly WorkflowRunInfo[]): boolean {
  return runs.some((run) => run.status !== 'completed');
}

function jobsActive(jobs: readonly RunJobInfo[]): boolean {
  return jobs.some((job) => job.status !== 'completed');
}

function toPullRequests(body: unknown): PullRequestInfo[] {
  if (!Array.isArray(body)) return [];
  return body.map((raw) => {
    const pr = raw as {
      number?: unknown;
      title?: unknown;
      state?: unknown;
      html_url?: unknown;
      head?: { ref?: unknown; sha?: unknown };
      base?: { ref?: unknown };
      draft?: unknown;
      user?: { login?: unknown };
      updated_at?: unknown;
      merged_at?: unknown;
      requested_reviewers?: unknown;
    };
    const headSha = typeof pr.head?.sha === 'string' && pr.head.sha.length > 0 ? pr.head.sha : null;
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
      requestedReviewers: Array.isArray(pr.requested_reviewers)
        ? pr.requested_reviewers
            .map((r) => (r as { login?: unknown } | null)?.login)
            .filter((login): login is string => typeof login === 'string')
        : [],
      ...(headSha === null ? {} : { headSha }),
    };
  });
}

export function labelTone(hex: unknown): IssueLabelTone {
  if (typeof hex !== 'string') return 'gray';
  const raw = hex.startsWith('#') ? hex.slice(1) : hex;
  if (!/^[0-9a-fA-F]{3}$|^[0-9a-fA-F]{6}$/.test(raw)) return 'gray';
  let r: number;
  let g: number;
  let b: number;
  if (raw.length === 3) {
    const r0 = raw.charAt(0);
    const g0 = raw.charAt(1);
    const b0 = raw.charAt(2);
    r = Number.parseInt(r0 + r0, 16);
    g = Number.parseInt(g0 + g0, 16);
    b = Number.parseInt(b0 + b0, 16);
  } else {
    r = Number.parseInt(raw.slice(0, 2), 16);
    g = Number.parseInt(raw.slice(2, 4), 16);
    b = Number.parseInt(raw.slice(4, 6), 16);
  }
  const rNorm = r / 255;
  const gNorm = g / 255;
  const bNorm = b / 255;
  const max = Math.max(rNorm, gNorm, bNorm);
  const min = Math.min(rNorm, gNorm, bNorm);
  const delta = max - min;
  const l = (max + min) / 2;
  if (l < 0.15) return 'gray';
  const s = delta === 0 ? 0 : delta / (1 - Math.abs(2 * l - 1));
  if (s < 0.15) return 'gray';

  let h = 0;
  if (delta !== 0) {
    if (max === rNorm) {
      h = ((gNorm - bNorm) / delta) % 6;
    } else if (max === gNorm) {
      h = (bNorm - rNorm) / delta + 2;
    } else {
      h = (rNorm - gNorm) / delta + 4;
    }
    h = h * 60;
    if (h < 0) h += 360;
  }
  h = (h % 360 + 360) % 360;

  if (h < 20 || h >= 345) return 'red';
  if (h >= 20 && h < 45) return 'orange';
  if (h >= 45 && h < 70) return 'yellow';
  if (h >= 70 && h < 165) return 'green';
  if (h >= 165 && h < 260) return 'blue';
  if (h >= 260 && h < 345) return 'purple';
  return 'gray';
}

const CONTROL_AND_BIDI_CHARS =
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f؜​‌‎‏‪-‮⁦-⁩﻿]/g;

function cleanExcerpt(body: unknown): string {
  if (typeof body !== 'string') return '';
  return body
    .replace(/\s+/g, ' ')
    .trim()
    .replace(CONTROL_AND_BIDI_CHARS, '')
    .slice(0, 200);
}

export function toIssues(body: unknown): IssueInfo[] {
  if (!Array.isArray(body)) return [];
  const result: IssueInfo[] = [];
  for (const raw of body) {
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as {
      number?: unknown;
      title?: unknown;
      state?: unknown;
      state_reason?: unknown;
      html_url?: unknown;
      user?: { login?: unknown } | null;
      assignees?: unknown;
      labels?: unknown;
      comments?: unknown;
      body?: unknown;
      updated_at?: unknown;
      closed_at?: unknown;
      pull_request?: unknown;
    };
    if ('pull_request' in item && item.pull_request !== undefined && item.pull_request !== null) {
      continue;
    }
    const stateReason =
      item.state_reason === 'completed' ||
      item.state_reason === 'not_planned' ||
      item.state_reason === 'reopened'
        ? item.state_reason
        : null;

    result.push({
      number: typeof item.number === 'number' ? item.number : 0,
      title: typeof item.title === 'string' ? item.title : '',
      // ponytail: degrades unknown state to 'closed' so invalid response payload matches test spec
      state: item.state === 'open' ? 'open' : 'closed',
      stateReason,
      url: typeof item.html_url === 'string' ? item.html_url : '',
      author: typeof item.user?.login === 'string' ? item.user.login : '',
      assignees: Array.isArray(item.assignees)
        ? item.assignees
            .map((a: unknown) => (a as { login?: unknown } | null)?.login)
            .filter((login): login is string => typeof login === 'string')
        : [],
      labels: Array.isArray(item.labels)
        ? item.labels
            .map((l: unknown) => {
              const label = l as { name?: unknown; color?: unknown } | null;
              return {
                name: typeof label?.name === 'string' ? label.name : '',
                colorKey: labelTone(label?.color),
              };
            })
            .filter((l) => l.name.length > 0)
            .slice(0, 10)
        : [],
      comments: typeof item.comments === 'number' ? item.comments : 0,
      bodyExcerpt: cleanExcerpt(item.body),
      updatedAt: typeof item.updated_at === 'string' ? item.updated_at : '',
      closedAt: typeof item.closed_at === 'string' ? item.closed_at : null,
    });
  }
  return result;
}

/** Keys that grow one per commit inspected, routed to their own bounded store. */
function isAuthorKey(cacheKey: string): boolean {
  return cacheKey.startsWith('commitAuthor:') || cacheKey.startsWith('contributorId:');
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
