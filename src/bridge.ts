/**
 * Host side of the webview message bridge.
 *
 * Responsibilities, in order, for every request:
 *   1. validate the payload            → 400 VALIDATION_ERROR
 *   2. resolve the repository          → 404 NOT_FOUND
 *   3. run the SafetyGuard (mutations) → structured error with remedies
 *   4. execute through GitRunner
 *   5. invalidate caches and emit `event/repoChanged`
 *   6. map GitError to the PRD status/code table
 *
 * `vscode` is not imported: the webview and the host services arrive as narrow
 * interfaces, so the dispatch table can be exercised without an editor.
 */
import { GitError } from './git';
import { GitHubError } from './github';
import { SafetyGuard, DEFAULT_STALENESS_MS, type GuardAction, type GuardSnapshot, type GuardVerdict } from './guard';
import { hostText } from './hostText';
import { redact, type Logger } from './logger';
import { parseRemoteUrl, stripCredentials } from './remoteUrl';
import type { RepositoryService } from './repository';
import {
  validateBranchName,
  validateHash,
  validateRemoteName,
  validateRepoRelativePath,
} from './validation';
import type {
  ActionResult,
  CommitAuthorInfo,
  CommitAuthorsPayload,
  CommitAuthorsResult,
  CommitDetail,
  CommitDetailPayload,
  CommitPayload,
  CommitResult,
  ErrorBody,
  ErrorCode,
  EventKind,
  EventMap,
  GitActionPayload,
  GitActionRequest,
  GitHubAuthState,
  GitHubLinkage,
  GitHubRepoInfo,
  GitHubRepoPayload,
  GraphPayload,
  HostEvent,
  HostMessage,
  Lang,
  MutationMeta,
  OpenDiffPayload,
  OpenDiffResult,
  OpenExternalPayload,
  PullRequestsPayload,
  PullRequestsResult,
  RemoteInfo,
  RepoGraph,
  RepoStatus,
  Request,
  RequestKind,
  Response,
  SettingsSetPayload,
  SettingsSnapshot,
  StagePayload,
  StatusPayload,
} from './messages';

/** Narrow slice of `vscode.Webview`. */
export interface WebviewLike {
  postMessage(message: HostMessage): Thenable<boolean>;
  onDidReceiveMessage(listener: (message: unknown) => void): { dispose(): void };
}

/**
 * Services the bridge needs from the activation layer.
 *
 * Everything that requires the `vscode` module arrives here as a callback,
 * because this file must stay importable without an editor. The GitHub and diff
 * members are optional so the dispatch table degrades to a structured
 * `UNAVAILABLE` instead of throwing when a host does not provide them.
 */
export interface BridgeHost {
  logger: Logger;
  /** Active repository, or `null` when the workspace has none. */
  resolveRepository(): Promise<RepositoryService | null>;
  settings(): SettingsSnapshot;
  setUiPreference(payload: SettingsSetPayload): Promise<SettingsSnapshot>;
  githubAuth(): Promise<GitHubAuthState>;
  connectGitHub(): Promise<GitHubAuthState>;
  disconnectGitHub(): Promise<GitHubAuthState>;
  /** Open a real diff editor. Implemented in `extension.ts`, which owns `vscode`. */
  openDiff?(payload: OpenDiffPayload): Promise<OpenDiffResult>;
  /** Reveal the output channel. Takes no parameters, so it cannot run commands. */
  showLogs?(): void;
  /** Open the explorer webview panel. Takes no parameters, so it cannot run commands. */
  openExplorer?(): void;
  /** Open an external URL. Host-side so the webview never navigates itself. */
  openExternal?(url: string): Promise<boolean>;
  githubRepo?(payload: GitHubRepoPayload): Promise<GitHubRepoInfo>;
  githubPullRequests?(payload: PullRequestsPayload): Promise<PullRequestsResult>;
  githubCommitAuthors?(payload: CommitAuthorsPayload): Promise<CommitAuthorsResult>;
  githubLinkage?(): Promise<GitHubLinkage>;
}

/**
 * Hosts this extension has a reason to open regardless of the repository.
 *
 * `github.com` is where every PR and commit link the GitHub panel builds points.
 * `git-scm.com` is the install/documentation target used when git is missing.
 * Everything beyond these two must be justified by the repository's own remote.
 */
const STATIC_EXTERNAL_HOSTS: readonly string[] = ['github.com', 'www.github.com', 'git-scm.com'];

const IDEMPOTENCY_TTL_MS = 300_000;
const IDEMPOTENCY_MAX_ENTRIES = 200;
/** Cap on stderr lines forwarded per operation so a chatty remote cannot flood. */
const PROGRESS_LINE_CAP = 40;

/** Idempotency record: the outcome only, so it can be re-stamped with a new id. */
type Outcome = { ok: true; data: unknown } | { ok: false; error: ErrorBody };

/** Thrown by handlers to produce a structured error response. */
class BridgeError extends Error {
  readonly body: ErrorBody;

  constructor(body: ErrorBody) {
    super(body.message);
    this.name = 'BridgeError';
    this.body = body;
  }
}

function fail(status: number, code: ErrorCode, message: string, extra: Partial<ErrorBody> = {}): never {
  throw new BridgeError({ status, code, message, ...extra });
}

export class MessageBridge {
  private readonly webview: WebviewLike;
  private readonly host: BridgeHost;
  private readonly subscription: { dispose(): void };
  /** Bounded, TTL'd store of completed mutations keyed by idempotency key. */
  private readonly completed = new Map<string, { at: number; outcome: Outcome }>();
  /**
   * Mutations that are running right now, keyed the same way.
   *
   * `completed` only answers a repeat that arrives after the first one finished. A
   * double click produces two requests microseconds apart, so the second one finds
   * an empty cache and starts a second `git push`. This map closes that window.
   */
  private readonly inFlight = new Map<string, Promise<Outcome>>();
  private disposed = false;

  constructor(webview: WebviewLike, host: BridgeHost) {
    this.webview = webview;
    this.host = host;
    this.subscription = webview.onDidReceiveMessage((raw) => {
      void this.handleRaw(raw);
    });
  }

  private text() {
    const lang = this.host.settings().language ?? 'en';
    return hostText(lang).bridge;
  }

  dispose(): void {
    this.disposed = true;
    this.subscription.dispose();
    this.completed.clear();
    this.inFlight.clear();
  }

  /** Push an unsolicited event to the webview. */
  emit<K extends EventKind>(kind: K, payload: EventMap[K]): void {
    if (this.disposed) return;
    const event: HostEvent<K> = { kind, payload };
    void this.webview.postMessage(event);
  }

  /** Tell the webview the repository moved. Called by the watcher and handlers. */
  async notifyRepoChanged(reason: 'fs' | 'action' | 'manual'): Promise<void> {
    const repo = await this.host.resolveRepository();
    let statusToken = '';
    if (repo !== null) {
      try {
        statusToken = (await repo.status()).statusToken;
      } catch {
        // A failing status must not swallow the change notification.
      }
    }
    this.emit('event/repoChanged', { reason, statusToken });
  }

  // ---------------------------------------------------------------- routing

  private async handleRaw(raw: unknown): Promise<void> {
    const request = parseRequest(raw);
    if (request === null) {
      this.host.logger.info('bridge/reject', 'malformed request envelope');
      return;
    }

    const key = idempotencyKeyOf(request);
    if (key !== null) {
      const prior = this.replay(key);
      if (prior !== null) {
        this.host.logger.info('bridge/replay', `${request.kind} ${key}`);
        // Re-stamp with the current request id so the caller's promise settles.
        void this.webview.postMessage(stamp(request.id, prior));
        return;
      }
      // Same key, still running: join it instead of starting a second one. Without
      // this the second half of a double click races the first through an empty
      // cache and both reach git (PRD Kasus 2).
      const running = this.inFlight.get(key);
      if (running !== undefined) {
        this.host.logger.info('bridge/join', `${request.kind} ${key}`);
        const outcome = await running;
        if (!this.disposed) void this.webview.postMessage(stamp(request.id, outcome));
        return;
      }
    }

    const settled = this.runRequest(request, key);
    if (key !== null) {
      this.inFlight.set(key, settled);
      // Detached: `settled` never rejects, and the map must be cleared whether or
      // not anyone joined.
      void settled.finally(() => {
        this.inFlight.delete(key);
      });
    }
    const outcome = await settled;
    if (!this.disposed) void this.webview.postMessage(stamp(request.id, outcome));
  }

  /** Run one request to an outcome. Never rejects. */
  private async runRequest(request: Request, key: string | null): Promise<Outcome> {
    const operationId = this.host.logger.nextOperationId();
    const started = Date.now();
    this.host.logger.log({ operationId, kind: request.kind, status: 'start' });

    let outcome: Outcome;
    try {
      outcome = { ok: true, data: await this.dispatch(request, operationId) };
      this.host.logger.log({
        operationId,
        kind: request.kind,
        status: 'ok',
        durationMs: Date.now() - started,
      });
    } catch (err) {
      const body = toErrorBody(err, this.host.settings().language ?? 'en');
      outcome = { ok: false, error: body };
      this.host.logger.log({
        operationId,
        kind: request.kind,
        status: 'fail',
        durationMs: Date.now() - started,
        detail: `${body.code} ${body.message}${body.detail === undefined ? '' : ` ${body.detail}`}`,
      });
    }

    if (key !== null) this.remember(key, outcome);
    return outcome;
  }

  /**
   * Dispatch table. Each arm narrows the payload itself; `request` arrives as a
   * union so the compiler cannot correlate kind and payload across the boundary.
   */
  private async dispatch(request: Request, operationId: string): Promise<unknown> {
    switch (request.kind) {
      case 'repos/status':
        return this.handleStatus(request.payload as StatusPayload);
      case 'repos/graph':
        return this.handleGraph(request.payload as GraphPayload);
      case 'repos/remotes':
        validateEmptyPayload(request.payload, this.text().invalid);
        return this.handleRemotes();
      case 'commits/detail':
        return this.handleCommitDetail(request.payload as CommitDetailPayload);
      case 'actions/stage':
        return this.handleStage(request.payload as StagePayload, operationId);
      case 'actions/commit':
        return this.handleCommit(request.payload as CommitPayload, operationId);
      case 'actions/git':
        return this.handleGitAction(request.payload as GitActionPayload, operationId);
      case 'actions/openDiff':
        return this.handleOpenDiff(request.payload as OpenDiffPayload);
      case 'actions/showLogs':
        return this.handleShowLogs();
      case 'actions/openExplorer':
        return this.handleOpenExplorer();
      case 'actions/openExternal':
        return this.handleOpenExternal(request.payload as OpenExternalPayload);
      case 'github/auth':
        validateEmptyPayload(request.payload, this.text().invalid);
        return this.host.githubAuth();
      case 'github/connect':
        validateEmptyPayload(request.payload, this.text().invalid);
        return this.host.connectGitHub();
      case 'github/disconnect':
        validateEmptyPayload(request.payload, this.text().invalid);
        return this.host.disconnectGitHub();
      case 'github/repo':
        return this.handleGitHubRepo(request.payload as GitHubRepoPayload);
      case 'github/pullRequests':
        return this.handleGitHubPullRequests(request.payload as PullRequestsPayload);
      case 'github/commitAuthors':
        return this.handleGitHubCommitAuthors(request.payload as CommitAuthorsPayload);
      case 'github/linkage':
        validateEmptyPayload(request.payload, this.text().invalid);
        return this.handleGitHubLinkage();
      case 'settings/get':
        { const keys = (request.payload as { keys?: unknown }).keys;
        if (keys !== undefined && (!Array.isArray(keys) || keys.some((key: unknown) => typeof key !== 'string'))) {
          fail(400, 'VALIDATION_ERROR', this.text().invalid, { detail: 'keys' });
        } }
        return this.host.settings();
      case 'settings/set':
        return this.handleSettingsSet(request.payload as SettingsSetPayload);
      default:
        return fail(400, 'VALIDATION_ERROR', this.text().invalid, {
          detail: `unknown kind: ${String(request.kind)}`,
        });
    }
  }

  // --------------------------------------------------------------- handlers

  private async handleStatus(payload: StatusPayload): Promise<RepoStatus> {
    if (payload.includeIgnored !== undefined && typeof payload.includeIgnored !== 'boolean') {
      fail(400, 'VALIDATION_ERROR', this.text().invalid, { detail: 'includeIgnored' });
    }
    const repo = await this.repository();
    return repo.status({ includeIgnored: payload.includeIgnored === true });
  }

  private async handleGraph(payload: GraphPayload): Promise<RepoGraph> {
    if (payload.limit !== undefined && !isPositiveInt(payload.limit)) {
      fail(400, 'VALIDATION_ERROR', this.text().invalid, { detail: 'limit' });
    }
    if (payload.cursor !== undefined && !isNonNegativeInt(payload.cursor)) {
      fail(400, 'VALIDATION_ERROR', this.text().invalid, { detail: 'cursor' });
    }
    const repo = await this.repository();
    const lang = this.host.settings().language ?? 'en';
    return repo.graph({
      ...(payload.limit === undefined ? {} : { limit: payload.limit }),
      ...(payload.cursor === undefined ? {} : { cursor: payload.cursor }),
      ...(payload.laneHeight === undefined ? {} : { laneHeight: payload.laneHeight }),
      ...(payload.columnWidth === undefined ? {} : { columnWidth: payload.columnWidth }),
      ...(payload.rowHeight === undefined ? {} : { rowHeight: payload.rowHeight }),
      ...(payload.laneWidth === undefined ? {} : { laneWidth: payload.laneWidth }),
      lang,
    });
  }

  private async handleCommitDetail(payload: CommitDetailPayload): Promise<CommitDetail> {
    if (!validateHash(payload.hash)) {
      fail(400, 'VALIDATION_ERROR', this.text().invalid, { detail: 'hash' });
    }
    if (payload.fileCursor !== undefined && !isNonNegativeInt(payload.fileCursor)) {
      fail(400, 'VALIDATION_ERROR', this.text().invalid, { detail: 'fileCursor' });
    }
    const repo = await this.repository();
    const detail = await repo.commitDetail(payload.hash, {
      ...(payload.fileCursor === undefined ? {} : { fileCursor: payload.fileCursor }),
    });
    if (detail === null) fail(404, 'NOT_FOUND', this.text().notFound);
    return detail;
  }

  /**
   * Configured remotes, with credentials stripped and the host parsed so the UI
   * can decide whether "Buka di GitHub" applies without re-parsing URLs itself.
   */
  private async handleRemotes(): Promise<{ remotes: RemoteInfo[] }> {
    const repo = await this.repository();
    const raw = await repo.git.remoteList();
    const remotes: RemoteInfo[] = raw.map((entry) => {
      const parsed = parseRemoteUrl(entry.fetchUrl) ?? parseRemoteUrl(entry.pushUrl);
      return {
        name: entry.name,
        // Never hand a token to the webview, even one the user pasted into a URL.
        fetchUrl: stripCredentials(entry.fetchUrl),
        pushUrl: stripCredentials(entry.pushUrl),
        host: parsed?.host ?? null,
        owner: parsed?.owner ?? null,
        repo: parsed?.repo ?? null,
        isGitHub: parsed?.isGitHub ?? false,
      };
    });
    return { remotes };
  }

  /**
   * Open a real diff editor. The work happens in `extension.ts` because opening
   * an editor needs `vscode`; this arm only validates and maps failures.
   */
  private async handleOpenDiff(payload: OpenDiffPayload): Promise<OpenDiffResult> {
    if (!validateRepoRelativePath(payload.path)) {
      fail(400, 'VALIDATION_ERROR', this.text().invalid, { detail: 'path' });
    }
    if (payload.hash !== undefined && !validateHash(payload.hash)) {
      fail(400, 'VALIDATION_ERROR', this.text().invalid, { detail: 'hash' });
    }
    if (payload.parent !== undefined && !validateHash(payload.parent)) {
      fail(400, 'VALIDATION_ERROR', this.text().invalid, { detail: 'parent' });
    }
    const open = this.host.openDiff;
    if (open === undefined) fail(503, 'UNAVAILABLE', this.text().diffUnavailable);
    // Resolving the repository first turns "no repo" into 404 rather than a
    // confusing editor error.
    await this.repository();
    return open(payload);
  }

  /**
   * Reveal the output channel. Deliberately parameterless: there is no way to
   * express "run command X" through this kind, so it cannot become an arbitrary
   * command-execution channel for the webview.
   */
  private handleShowLogs(): { shown: boolean } {
    const show = this.host.showLogs;
    if (show === undefined) return { shown: false };
    show();
    return { shown: true };
  }

  /**
   * Open the explorer panel. Deliberately parameterless: there is no way to
   * express "run command X" through this kind, so it cannot become an arbitrary
   * command-execution channel for the webview.
   */
  private handleOpenExplorer(): { opened: boolean } {
    const open = this.host.openExplorer;
    if (open === undefined) return { opened: false };
    open();
    return { opened: true };
  }

  /**
   * Open an external URL.
   *
   * Two independent gates. The scheme must be exactly `https:`, which is what
   * keeps `file:`, `vscode:`, `command:`, `data:`, and `javascript:` out — parsed
   * with WHATWG `URL` rather than a prefix test, so the scheme checked is the
   * scheme `vscode.Uri.parse` will act on. Then the host must be one the
   * extension has a reason to open: `github.com`, `git-scm.com`, the host of the
   * configured GitHub API base, or the host of a remote this repository actually
   * has. A malicious `origin` can therefore only aim a link at itself, which the
   * user could have reached by clicking the remote anyway.
   *
   * Embedded userinfo is rejected outright: `https://github.com@evil.example/`
   * reads as GitHub to a human and resolves to `evil.example`.
   */
  private async handleOpenExternal(payload: OpenExternalPayload): Promise<{ opened: boolean }> {
    if (typeof payload.url !== 'string' || payload.url.length === 0) {
      fail(400, 'VALIDATION_ERROR', this.text().externalBlocked, { detail: 'url' });
    }
    // A backslash is a path separator to the WHATWG parser and an ordinary
    // character to several others, so `https:/\/\github.com/x` means different
    // things to `new URL()` and to `vscode.Uri.parse`. Whatever the host would
    // open, this check is the one that decided — so refuse the ambiguity instead
    // of validating one parser's answer and acting on another's. No legitimate
    // link this extension builds contains one.
    if (payload.url.includes('\\')) {
      fail(400, 'VALIDATION_ERROR', this.text().externalBlocked, { detail: 'url' });
    }
    let parsed: URL;
    try {
      parsed = new URL(payload.url);
    } catch {
      return fail(400, 'VALIDATION_ERROR', this.text().externalBlocked, { detail: 'url' });
    }
    if (parsed.protocol !== 'https:') {
      fail(400, 'VALIDATION_ERROR', this.text().externalBlocked, { detail: 'scheme' });
    }
    if (parsed.username.length > 0 || parsed.password.length > 0) {
      fail(400, 'VALIDATION_ERROR', this.text().externalBlocked, { detail: 'userinfo' });
    }
    const allowed = await this.allowedExternalHosts();
    if (!allowed.includes(parsed.hostname.toLowerCase())) {
      fail(400, 'VALIDATION_ERROR', this.text().externalBlocked, { detail: 'host' });
    }
    const open = this.host.openExternal;
    if (open === undefined) fail(503, 'UNAVAILABLE', this.text().unavailable);
    return { opened: await open(payload.url) };
  }

  /**
   * Hosts `actions/openExternal` may target, lower-cased.
   *
   * Derived, not configured: the static pair, plus the configured API base's host
   * (an Enterprise user's links live there and the setting is `machine`-scoped, so
   * a workspace cannot extend the allowlist), plus every host this repository's
   * own remotes parse to. A repository with no remotes gets the static pair only.
   */
  private async allowedExternalHosts(): Promise<string[]> {
    const hosts = new Set<string>(STATIC_EXTERNAL_HOSTS);
    const configured = this.host.settings().githubApiUrl;
    if (typeof configured === 'string' && configured.length > 0) {
      try {
        const base = new URL(configured);
        if (base.protocol === 'https:') hosts.add(base.hostname.toLowerCase());
      } catch {
        // A malformed setting simply contributes nothing.
      }
    }
    try {
      const repo = await this.host.resolveRepository();
      if (repo !== null) {
        for (const entry of await repo.git.remoteList()) {
          const parsed = parseRemoteUrl(entry.fetchUrl) ?? parseRemoteUrl(entry.pushUrl);
          if (parsed !== null) hosts.add(parsed.host.toLowerCase());
        }
      }
    } catch {
      // No repository, or git failed: the static hosts still apply.
    }
    return [...hosts];
  }

  private async handleGitHubRepo(payload: GitHubRepoPayload): Promise<GitHubRepoInfo> {
    if (!isSlug(payload.owner) || !isSlug(payload.repo)) {
      fail(400, 'VALIDATION_ERROR', this.text().invalid, { detail: 'owner/repo' });
    }
    const fetchRepo = this.host.githubRepo;
    if (fetchRepo === undefined) fail(503, 'UNAVAILABLE', this.text().githubPending);
    return fetchRepo(payload);
  }

  private async handleGitHubPullRequests(payload: PullRequestsPayload): Promise<PullRequestsResult> {
    if (!isSlug(payload.owner) || !isSlug(payload.repo)) {
      fail(400, 'VALIDATION_ERROR', this.text().invalid, { detail: 'owner/repo' });
    }
    if (payload.state !== undefined && !['open', 'closed', 'all'].includes(payload.state)) {
      fail(400, 'VALIDATION_ERROR', this.text().invalid, { detail: 'state' });
    }
    const list = this.host.githubPullRequests;
    if (list === undefined) fail(503, 'UNAVAILABLE', this.text().githubPending);
    return list(payload);
  }

  private async handleGitHubCommitAuthors(payload: CommitAuthorsPayload): Promise<CommitAuthorsResult> {
    if (!isSlug(payload.owner) || !isSlug(payload.repo)) {
      fail(400, 'VALIDATION_ERROR', this.text().invalid, { detail: 'owner/repo' });
    }
    if (!Array.isArray(payload.hashes) || payload.hashes.length > 50) {
      fail(400, 'VALIDATION_ERROR', this.text().invalid, { detail: 'hashes' });
    }
    for (const h of payload.hashes) {
      if (!validateHash(h)) {
        fail(400, 'VALIDATION_ERROR', this.text().invalid, { detail: 'hashes' });
      }
    }
    const authors = this.host.githubCommitAuthors;
    if (authors === undefined) fail(503, 'UNAVAILABLE', this.text().githubPending);
    return authors(payload);
  }

  private async handleGitHubLinkage(): Promise<GitHubLinkage> {
    const linkage = this.host.githubLinkage;
    if (linkage === undefined) fail(503, 'UNAVAILABLE', this.text().githubPending);
    return linkage();
  }

  private async handleStage(payload: StagePayload, operationId: string): Promise<ActionResult> {
    if (!Array.isArray(payload.paths) || payload.paths.length === 0) {
      fail(400, 'VALIDATION_ERROR', this.text().invalid, { detail: 'paths' });
    }
    for (const p of payload.paths) {
      if (!validateRepoRelativePath(p)) {
        fail(400, 'VALIDATION_ERROR', this.text().invalid, { detail: 'paths' });
      }
    }
    if (typeof payload.stage !== 'boolean') {
      fail(400, 'VALIDATION_ERROR', this.text().invalid, { detail: 'stage' });
    }

    const repo = await this.repository();
    const status = await this.assertToken(repo, payload.statusToken);
    this.gate({ action: 'stage' }, status, payload);

    const kind = payload.stage ? 'stage' : 'unstage';
    return this.run(repo, operationId, kind, async () => {
      if (payload.stage) await repo.git.stage(payload.paths);
      else await repo.git.unstage(payload.paths);
    });
  }

  /**
   * Commit uses ONLY what is already staged. When `push` is requested and fails
   * the commit is kept: the response reports `pushed: false` plus `pushError`
   * so the UI can offer "Retry Push".
   */
  private async handleCommit(payload: CommitPayload, operationId: string): Promise<CommitResult> {
    if (typeof payload.message !== 'string') {
      fail(400, 'VALIDATION_ERROR', this.text().invalid, { detail: 'message' });
    }
    const repo = await this.repository();
    const status = await this.assertToken(repo, payload.statusToken);
    this.gate({ action: 'commit' }, status, payload);

    this.progress(operationId, 'commit', 'started');
    let commit: string | null;
    try {
      commit = await repo.git.commit(payload.message, {
        ...(payload.amend === undefined ? {} : { amend: payload.amend }),
      });
    } catch (err) {
      this.progress(operationId, 'commit', 'failed', messageOf(err));
      repo.invalidate();
      await this.notifyRepoChanged('action');
      throw err;
    }
    repo.invalidate();

    let pushed = false;
    let pushError: string | undefined;
    if (payload.push === true) {
      const outcome = await this.pushCurrentBranch(repo, operationId);
      pushed = outcome.pushed;
      pushError = outcome.error;
      repo.invalidate();
    }

    this.progress(operationId, 'commit', 'finished');
    await this.notifyRepoChanged('action');
    const after = await repo.status();
    return {
      success: true,
      commit,
      pushed,
      ...(pushError === undefined ? {} : { pushError }),
      operation: after.operation,
      statusToken: after.statusToken,
    };
  }

  /**
   * Run one git action.
   *
   * Freshness is enforced the same way stage and commit enforce it: when the
   * request carries a `statusToken` it must match the status the host reads now,
   * otherwise 409. `actions/git` is where the destructive actions live, so it
   * needed this more than the two paths that already had it.
   *
   * `reset-hard` additionally re-evaluates the guard INSIDE the exclusive lock —
   * see {@link narrowedResetHard}.
   */
  private async handleGitAction(payload: GitActionPayload, operationId: string): Promise<ActionResult> {
    validateAction(payload, this.text().invalid);
    const repo = await this.repository();
    const status = await this.assertToken(repo, payload.statusToken);
    this.gate(payload as GuardAction, status, payload);

    // `push-up-to` must be fast-forward; the remedy is fetch, never force.
    //
    // Direction matters and is easy to get backwards: a push of `hash` onto the
    // remote branch fast-forwards only when the REMOTE tip is reachable from
    // `hash`. Asking it the other way round ("is `hash` already on the remote?")
    // is true only for a commit that has been pushed already, so it rejected every
    // partial push that actually had something to send.
    //
    // A missing remote-tracking ref (never fetched, or a branch the remote does
    // not have yet) makes `isAncestor` fail; that is not a divergence, so it falls
    // through to git, which enforces fast-forward itself and reports
    // NON_FAST_FORWARD through the stderr classifier.
    if (payload.action === 'push-up-to') {
      const remoteRef = `refs/remotes/${payload.remote}/${payload.branch}`;
      const ff = await repo.git.isAncestor(remoteRef, payload.hash).catch(() => true);
      if (!ff) {
        fail(409, 'NON_FAST_FORWARD', this.text().nonFastForward, { remedies: ['fetch'] });
      }
    }

    return this.run(repo, operationId, payload.action, () => this.execute(repo, payload, operationId));
  }

  private async handleSettingsSet(payload: SettingsSetPayload): Promise<SettingsSnapshot> {
    if (typeof payload.key !== 'string' || payload.key.length === 0) {
      fail(400, 'VALIDATION_ERROR', this.text().invalid, { detail: 'key' });
    }
    const type = typeof payload.value;
    if (type !== 'string' && type !== 'number' && type !== 'boolean') {
      fail(400, 'VALIDATION_ERROR', this.text().invalid, { detail: 'value' });
    }
    return this.host.setUiPreference(payload);
  }

  // ---------------------------------------------------------------- helpers

  /** Run one git action. Mutation dispatch lives here, not in the guard. */
  private async execute(
    repo: RepositoryService,
    action: GitActionPayload,
    operationId: string,
  ): Promise<void> {
    const git = repo.git;
    switch (action.action) {
      case 'checkout-branch':
        return git.switchBranch(action.branch);
      case 'checkout-commit':
        return git.checkoutDetached(action.hash);
      case 'create-branch':
        return git.createBranch(action.name, action.startPoint);
      case 'merge':
        return git.merge(action.branch, {
          ...(action.noFf === undefined ? {} : { noFf: action.noFf }),
        });
      case 'revert':
        return git.revert(action.hash);
      case 'reset-soft':
        return git.resetSoft(action.hash);
      case 'reset-hard':
        return this.narrowedResetHard(repo, action.hash, action as GitActionPayload);
      case 'push':
        return git.push({
          remote: action.remote,
          refspec: `${action.branch}:${action.branch}`,
          ...(action.setUpstream === undefined ? {} : { setUpstream: action.setUpstream }),
          onProgress: this.progressSink(operationId, 'push'),
        });
      case 'push-up-to':
        return git.push({
          remote: action.remote,
          refspec: `${action.hash}:refs/heads/${action.branch}`,
          onProgress: this.progressSink(operationId, 'push-up-to'),
        });
      case 'fetch': {
        await git.fetch({
          ...(action.remote === undefined ? {} : { remote: action.remote }),
          ...(action.prune === undefined ? {} : { prune: action.prune }),
          onProgress: this.progressSink(operationId, 'fetch'),
        });
        await repo.markFetched();
        return;
      }
      case 'stash':
        return git.stashPush(action.message, {
          ...(action.includeUntracked === undefined ? {} : { includeUntracked: action.includeUntracked }),
        });
      case 'stash-pop':
        return git.stashPop();
      case 'merge-continue':
        return git.mergeContinue();
      case 'merge-abort':
        return git.mergeAbort();
      default:
        return fail(400, 'VALIDATION_ERROR', this.text().invalid);
    }
  }

  /**
   * `reset --hard` with the guard re-evaluated inside the exclusive lock.
   *
   * The ordinary sequence is: read status → guard → take the lock → run git. That
   * leaves a window in which an external process — a terminal, another extension,
   * a plain editor save — can dirty the tree after the guard concluded it was
   * clean, and `reset --hard` would then discard work the guard believed absent.
   *
   * `precheck` runs after the lock is held and immediately before git, which is the
   * narrowest point the architecture allows: it invalidates the status cache, reads
   * the tree again, and re-applies the guard. Anything it rejects surfaces as the
   * guard's own error rather than as lost work.
   *
   * What remains: `precheck` still spawns `git status`, so between that read
   * returning and `git reset --hard` starting there is a window of one process
   * spawn. It cannot be closed from here — the lock is this extension's, not the
   * filesystem's, and only git's own index lock is shared. `assertNotLocked` covers
   * a concurrent git; it does not cover an editor writing a file.
   */
  private async narrowedResetHard(
    repo: RepositoryService,
    hash: string,
    meta: GitActionPayload,
  ): Promise<void> {
    await repo.git.resetHard(hash, {
      precheck: async () => {
        repo.invalidate();
        const fresh = await repo.status();
        this.gate({ action: 'reset-hard', hash }, fresh, meta);
      },
    });
  }


  private async run(
    repo: RepositoryService,
    operationId: string,
    kind: string,
    fn: () => Promise<void>,
  ): Promise<ActionResult> {
    this.progress(operationId, kind, 'started');
    try {
      await fn();
    } catch (err) {
      this.progress(operationId, kind, 'failed', messageOf(err));
      repo.invalidate();
      await this.notifyRepoChanged('action');
      throw err;
    }
    repo.invalidate();
    this.progress(operationId, kind, 'finished');
    await this.notifyRepoChanged('action');
    const status = await repo.status();
    return { ok: true, operation: status.operation, statusToken: status.statusToken };
  }

  /** Push HEAD's branch. Never throws: the caller reports `pushError` instead. */
  private async pushCurrentBranch(
    repo: RepositoryService,
    operationId: string,
  ): Promise<{ pushed: boolean; error?: string }> {
    const status = await repo.status();
    if (status.branch === null) {
      return { pushed: false, error: this.text().commitPushFailed };
    }
    const snapshot = this.snapshotOf(status);
    const lang = this.host.settings().language ?? 'en';
    const verdict = SafetyGuard.evaluate({ action: 'push', remote: 'origin', branch: status.branch }, snapshot, lang);
    if (!verdict.allow) {
      return { pushed: false, error: verdict.message };
    }
    try {
      await repo.git.push({
        remote: 'origin',
        refspec: `${status.branch}:${status.branch}`,
        setUpstream: status.upstream === null,
        onProgress: this.progressSink(operationId, 'push'),
      });
      return { pushed: true };
    } catch (err) {
      return { pushed: false, error: messageOf(err) };
    }
  }

  /**
   * Apply the guard and enforce confirmation host-side. A blocked verdict that
   * only requires confirmation passes once the request carries `confirm: true`
   * (and `forceAcknowledgement: true` at level 2), so omitting a flag can never
   * be a bypass.
   */
  private gate(action: GuardAction, status: RepoStatus, meta: MutationMeta): void {
    const lang = this.host.settings().language ?? 'en';
    const verdict = SafetyGuard.evaluate(action, this.snapshotOf(status), lang);
    if (verdict.allow) return;
    if (verdict.requiresConfirmation === true && this.confirmed(verdict, meta)) return;
    fail(verdictStatus(verdict), verdict.code, verdict.message, {
      remedies: verdict.remedies,
      ...(verdict.requiresConfirmation === undefined
        ? {}
        : { requiresConfirmation: verdict.requiresConfirmation }),
      ...(verdict.confirmationLevel === undefined
        ? {}
        : { confirmationLevel: verdict.confirmationLevel }),
      ...(verdict.risk === undefined ? {} : { risk: verdict.risk }),
    });
  }

  private confirmed(verdict: Extract<GuardVerdict, { allow: false }>, meta: MutationMeta): boolean {
    if (meta.confirm !== true) return false;
    if (verdict.confirmationLevel === 2) return meta.forceAcknowledgement === true;
    return true;
  }

  private snapshotOf(status: RepoStatus): GuardSnapshot {
    return {
      dirty: status.dirty,
      staged: status.staged,
      conflicted: status.conflicts.length > 0,
      operation: status.operation,
      ahead: status.ahead,
      behind: status.behind,
      upstream: status.upstream,
      lastFetchAt: status.lastFetchAt,
      now: Date.now(),
      stalenessMs: this.host.settings().fetchStalenessMs || DEFAULT_STALENESS_MS,
    };
  }

  private async repository(): Promise<RepositoryService> {
    const repo = await this.host.resolveRepository();
    if (repo === null) fail(404, 'NOT_FOUND', this.text().noRepository);
    return repo;
  }

  /**
   * Reject a mutation computed against a status snapshot that has moved on.
   *
   * An absent or empty token means "the caller has no snapshot to compare", which
   * is accepted: `actions/git` made the field optional for compatibility, and a
   * host-initiated action has no webview snapshot at all. A token that is present
   * and different is always a conflict.
   */
  private async assertToken(repo: RepositoryService, token: string | undefined): Promise<RepoStatus> {
    const status = await repo.status();
    if (typeof token === 'string' && token.length > 0 && token !== status.statusToken) {
      fail(409, 'CONFLICT', this.text().staleToken, { remedies: ['cancel'] });
    }
    return status;
  }

  private progress(id: string, operation: string, phase: EventMap['event/operationProgress']['phase'], message?: string): void {
    this.emit('event/operationProgress', {
      id,
      operation,
      phase,
      ...(message === undefined ? {} : { message }),
    });
  }

  /** Stderr line sink that streams a bounded live log to the webview. */
  private progressSink(operationId: string, operation: string): (line: string) => void {
    let count = 0;
    return (line: string): void => {
      count += 1;
      if (count > PROGRESS_LINE_CAP) return;
      this.progress(operationId, operation, 'progress', line);
    };
  }

  // ----------------------------------------------------------- idempotency

  private replay(key: string): Outcome | null {
    this.evictExpired();
    const entry = this.completed.get(key);
    return entry === undefined ? null : entry.outcome;
  }

  private remember(key: string, outcome: Outcome): void {
    if (!shouldRemember(outcome)) return;
    this.evictExpired();
    this.completed.set(key, { at: Date.now(), outcome });
    // Map preserves insertion order, so the first key is the oldest.
    while (this.completed.size > IDEMPOTENCY_MAX_ENTRIES) {
      const oldest = this.completed.keys().next();
      if (oldest.done === true) break;
      this.completed.delete(oldest.value);
    }
  }

  private evictExpired(): void {
    const cutoff = Date.now() - IDEMPOTENCY_TTL_MS;
    for (const [key, entry] of this.completed) {
      if (entry.at >= cutoff) break; // insertion order === age order
      this.completed.delete(key);
    }
  }
}

// ------------------------------------------------------------------ parsing

/** Attach a request id to an outcome, producing the wire response. */
function stamp(id: string, outcome: Outcome): Response {
  return (outcome.ok ? { id, ok: true, data: outcome.data } : { id, ok: false, error: outcome.error }) as Response;
}

/** Structurally validate the envelope. Payload shape is checked per handler. */
function parseRequest(raw: unknown): Request | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const candidate = raw as { id?: unknown; kind?: unknown; payload?: unknown };
  if (typeof candidate.id !== 'string' || candidate.id.length === 0) return null;
  if (typeof candidate.kind !== 'string') return null;
  if (typeof candidate.payload !== 'object' || candidate.payload === null) return null;
  return {
    id: candidate.id,
    kind: candidate.kind as RequestKind,
    payload: candidate.payload as Request['payload'],
  };
}

function validateEmptyPayload(payload: object, msg: string = 'Invalid request.'): void {
  if (Object.keys(payload).length > 0) fail(400, 'VALIDATION_ERROR', msg, { detail: 'payload' });
}

const MUTATION_KINDS = new Set<string>(['actions/stage', 'actions/commit', 'actions/git']);

/**
 * Codes that describe the *request*, not the repository, and that the user
 * resolves by sending the same request again with more on it.
 *
 * The webview reuses one idempotency key across a confirmation dialog — by design,
 * because that is what stops a double-clicked push from pushing twice. Caching a
 * guard rejection under that key means the retry that carries `confirm: true` is
 * answered from the cache and never reaches the guard, so `reset --hard`, `revert`,
 * `reset-soft`, and `push-up-to` become unconfirmable. These outcomes are therefore
 * not remembered; the guard re-runs on every attempt, which is also the only way it
 * can see the repository as it is at that moment.
 */
const RETRYABLE_CODES = new Set<ErrorCode>(['CONFIRMATION_REQUIRED', 'DIRTY_TREE', 'STALE_STATUS']);

/**
 * Whether an outcome may be replayed for a repeated idempotency key.
 *
 * Successes always are — that is the entire point of the map (PRD Kasus 2: a
 * double-clicked push must not push twice), and it is preserved unchanged.
 * Genuine failures are too: a hook rejection or a non-fast-forward is a fact about
 * the repository, and replaying it is honest. Only the guard rejections above are
 * excluded, because they are answers to an incomplete request rather than outcomes
 * of an attempt.
 */
function shouldRemember(outcome: Outcome): boolean {
  if (outcome.ok) return true;
  return !RETRYABLE_CODES.has(outcome.error.code);
}

/** Idempotency applies to mutations only; reads are cheap and always fresh. */
function idempotencyKeyOf(request: Request): string | null {
  if (!MUTATION_KINDS.has(request.kind)) return null;
  const payload = request.payload as { idempotencyKey?: unknown };
  if (typeof payload.idempotencyKey !== 'string' || payload.idempotencyKey.length === 0) return null;
  return `${request.kind}:${payload.idempotencyKey}`;
}

/** Per-action argument validation before anything reaches git. */
function validateAction(action: GitActionPayload, msg: string = 'Invalid request.'): void {
  const bad = (detail: string): never =>
    fail(400, 'VALIDATION_ERROR', msg, { detail });

  switch (action.action) {
    case 'checkout-branch':
      if (!validateBranchName(action.branch)) bad('branch');
      return;
    case 'checkout-commit':
    case 'revert':
    case 'reset-soft':
    case 'reset-hard':
      if (!validateHash(action.hash)) bad('hash');
      return;
    case 'create-branch':
      if (!validateBranchName(action.name)) bad('name');
      if (!validateBranchName(action.startPoint) && !validateHash(action.startPoint)) bad('startPoint');
      return;
    case 'merge':
      if (!validateBranchName(action.branch)) bad('branch');
      return;
    case 'push':
      if (!validateRemoteName(action.remote)) bad('remote');
      if (!validateBranchName(action.branch)) bad('branch');
      return;
    case 'push-up-to':
      if (!validateRemoteName(action.remote)) bad('remote');
      if (!validateBranchName(action.branch)) bad('branch');
      if (!validateHash(action.hash)) bad('hash');
      return;
    case 'fetch':
      if (action.remote !== undefined && !validateRemoteName(action.remote)) bad('remote');
      return;
    case 'stash':
      if (typeof action.message !== 'string') bad('message');
      return;
    case 'stash-pop':
    case 'merge-continue':
    case 'merge-abort':
      return;
    default:
      bad('action');
  }
}

// ------------------------------------------------------------ error mapping

function verdictStatus(verdict: Extract<GuardVerdict, { allow: false }>): number {
  switch (verdict.code) {
    case 'DIRTY_TREE':
    case 'STALE_STATUS':
      return 412;
    case 'CONFIRMATION_REQUIRED':
      return 428;
    default:
      return 409;
  }
}

/** Map any thrown value onto the PRD's status/code table. */
export function toErrorBody(err: unknown, lang: Lang = 'en'): ErrorBody {
  if (err instanceof BridgeError) return err.body;
  if (err instanceof GitError) return fromGitError(err, lang);
  if (err instanceof GitHubError) return fromGitHubError(err);
  return { status: 500, code: 'SERVER_ERROR', message: messageOf(err) };
}

/**
 * GitHub failures already carry their status and code; the reset timestamp is
 * forwarded in `detail` so the UI can render the countdown badge.
 */
function fromGitHubError(err: GitHubError): ErrorBody {
  return {
    status: err.status,
    code: err.code,
    message: err.message,
    ...(err.detail === undefined && err.resetAt === undefined
      ? {}
      : { detail: err.resetAt === undefined ? (err.detail as string) : `resetAt=${err.resetAt}` }),
  };
}

function fromGitError(err: GitError, lang: Lang = 'en'): ErrorBody {
  const text = hostText(lang).bridge;
  switch (err.code) {
    case 'VALIDATION_ERROR':
      return { status: 400, code: 'VALIDATION_ERROR', message: text.invalid, detail: redact(err.message) };
    case 'REPOSITORY_LOCKED':
      return { status: 409, code: 'REPOSITORY_LOCKED', message: text.locked };
    case 'GIT_TIMEOUT':
      return { status: 504, code: 'UNAVAILABLE', message: text.timeout, detail: redact(err.message) };
    case 'GIT_SPAWN_FAILED':
      return { status: 503, code: 'UNAVAILABLE', message: text.unavailable, detail: redact(err.message) };
    case 'GIT_OUTPUT_TOO_LARGE':
      // 413: the request was valid, the response is too big to hand over. The UI
      // renders it through the SERVER_ERROR arm, which already offers Show Logs.
      return { status: 413, code: 'SERVER_ERROR', message: text.outputTooLarge, detail: redact(err.message) };
    case 'GIT_FAILED':
    default:
      return fromGitFailure(err, lang);
  }
}

const HOOK_MARKERS = [/\bhook\b/i, /hooks\//i, /declined/i];
const NON_FF_MARKERS = [/non-fast-forward/i, /fetch first/i, /\[rejected\]/i, /behind its remote/i];

/**
 * Classify a generic git failure from stderr. Hook output is surfaced verbatim
 * in `detail` because it is the only place the reason lives.
 *
 * Redacted on the way out. The same stderr is already redacted en route to the
 * output channel via `formatRecord`, so leaving this path raw meant the log was
 * clean while the webview DTO was not — and `detail` is what users screenshot
 * into bug reports. Git's own credential helpers do echo URLs on failure.
 */
function fromGitFailure(err: GitError, lang: Lang = 'en'): ErrorBody {
  const text = hostText(lang).bridge;
  const stderr = redact(err.stderr.length > 0 ? err.stderr : err.message);
  if (HOOK_MARKERS.some((m) => m.test(stderr))) {
    return {
      status: 409,
      code: 'HOOK_REJECTED',
      message: text.hookRejected,
      detail: stderr.trim(),
    };
  }
  if (NON_FF_MARKERS.some((m) => m.test(stderr))) {
    return {
      status: 409,
      code: 'NON_FAST_FORWARD',
      message: text.nonFastForward,
      detail: stderr.trim(),
      remedies: ['fetch'],
    };
  }
  return { status: 500, code: 'SERVER_ERROR', message: redact(err.message), detail: stderr.trim() };
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isPositiveInt(value: unknown): boolean {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function isNonNegativeInt(value: unknown): boolean {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/** GitHub owner/repo segment: no slashes, no dots-only, no option-like prefix. */
function isSlug(value: unknown): boolean {
  return typeof value === 'string' && value.length > 0 && value.length <= 100 && /^[A-Za-z0-9._-]+$/.test(value);
}

