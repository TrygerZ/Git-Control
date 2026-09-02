/**
 * Typed message contract between the extension host and the webview.
 * Request kinds mirror the PRD's REST-equivalent endpoints. Fully typed so
 * `bridge.request('repos/graph', payload)` infers the response shape. No `any`.
 */

export type Lang = 'en' | 'id';

// ------------------------------------------------------------------ errors

export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'AUTH_ERROR'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'RATE_LIMITED'
  | 'SERVER_ERROR'
  | 'UNAVAILABLE'
  | 'REPOSITORY_LOCKED'
  | 'DIRTY_TREE'
  | 'REMOTE_AHEAD'
  | 'STALE_STATUS'
  | 'NON_FAST_FORWARD'
  | 'HOOK_REJECTED'
  | 'CONFIRMATION_REQUIRED';

/** Remedies the UI may offer when an action is blocked by the safety guard. */
export type Remedy = 'commit' | 'stash' | 'fetch' | 'cancel' | 'resolve-conflicts' | 'confirm';

export interface ErrorBody {
  status: number;
  code: ErrorCode;
  message: string;
  detail?: string;
  /** Buttons the UI should render for a guard-blocked action. */
  remedies?: Remedy[];
  requiresConfirmation?: boolean;
  confirmationLevel?: 1 | 2;
  risk?: 'low' | 'medium' | 'high';
}

// ------------------------------------------------------------- domain DTOs

export type OperationState = 'idle' | 'merge' | 'rebase' | 'cherry-pick' | 'revert' | 'bisect';

export interface RefInfo {
  /** Full ref name, e.g. `refs/heads/main`. */
  refName: string;
  /** Short display name, e.g. `main` or `origin/main`. */
  shortName: string;
  /**
   * `other` covers git's pseudo-refs and bookkeeping refs — `refs/stash`,
   * `refs/notes/*`, `refs/bisect/*`, `refs/replace/*`, bare `HEAD`. They are real
   * objects and may be drawn, but they are NOT branches: `git switch`/`git merge`
   * reject them with `fatal: a branch is expected`, so no consumer may offer them
   * as a checkout or merge target.
   */
  kind: 'local' | 'remote' | 'tag' | 'other';
  objectName: string;
  upstream: string | null;
  ahead: number;
  behind: number;
  isHead: boolean;
}

export interface ChangeEntry {
  path: string;
  origPath?: string;
  indexStatus: string;
  worktreeStatus: string;
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
  additions: number | null;
  deletions: number | null;
  binary: boolean;
}

export interface ConflictEntry {
  path: string;
  code: string;
}

export interface RepoStatus {
  repoRoot: string;
  branch: string | null;
  head: string | null;
  detached: boolean;
  upstream: string | null;
  ahead: number;
  behind: number;
  /** Alias of {@link behind}: commits the remote has that we do not. */
  incoming: number;
  /** Alias of {@link ahead}: commits we have that the remote does not. */
  outgoing: number;
  /** Any unstaged/untracked change present in the working tree. */
  dirty: boolean;
  /** Any change present in the index. */
  staged: boolean;
  operation: OperationState;
  changes: ChangeEntry[];
  conflicts: ConflictEntry[];
  /**
   * True when the per-file line counts in {@link changes} are known to be
   * incomplete, so a `null` churn on a tracked file means "not counted" and not
   * "not changed".
   *
   * Two different causes set this: a `git diff --numstat` read that hit its byte
   * cap, and a change list so large that the counts were never asked for at all.
   * They stay ONE boolean rather than a variant union because the reader's
   * situation is identical in both - some rows show no numbers even though the
   * file did change - and no consumer would render, log, or act on the two causes
   * differently. A union would add a branch nobody takes.
   */
  churnTruncated: boolean;
  /** Server-computed token used to reject actions built on stale status. */
  statusToken: string;
  lastFetchedAt: string | null;
  /** Same value as {@link lastFetchedAt} as epoch ms, or `null` when never fetched. */
  lastFetchAt: number | null;
}

export interface GraphNode {
  hash: string;
  shortHash: string;
  x: number;
  y: number;
  lane: number;
  isHead: boolean;
  isMerge: boolean;
  /** True when the commit is not reachable from any remote-tracking ref. */
  local: boolean;
  subject: string;
  authorName: string;
  authoredAt: string;
  refNames: string[];
  /** Deterministic branch name attribution (null if no branch). */
  branchName?: string | null;
  /** Color hex code corresponding to the attributed branch. */
  branchColor?: string | null;
}

export interface GraphEdge {
  from: string;
  to: string;
  fromLane: number;
  toLane: number;
  kind: 'direct' | 'merge';
}

export interface GraphLane {
  index: number;
  ref?: string;
  color: string;
}

export interface DateBucket {
  label: string;
  timestamp: number;
  startX: number;
  width: number;
  commitCount: number;
  /** 0-based ordinal position among all date buckets in chronological order. */
  index: number;
  /** World-space X coordinate where the day band background and ruler cell begin. */
  bandStartX: number;
  /** World-space width of the day band and ruler cell. */
  bandWidth: number;
}

export interface RepoGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  lanes: GraphLane[];
  dateBuckets: DateBucket[];
  refs: RefInfo[];
  head: string | null;
  truncated: boolean;
  /** Skip value for the next page, or `null` when the history is exhausted. */
  nextCursor: number | null;
  /** `true` when the payload is a cached snapshot served after a git failure. */
  stale: boolean;
}

export interface CommitFileChange {
  path: string;
  origPath?: string;
  additions: number | null;
  deletions: number | null;
  binary: boolean;
}

export interface CommitDetail {
  hash: string;
  shortHash: string;
  parents: string[];
  authorName: string;
  authorEmail: string;
  authoredAt: string;
  committerName: string;
  committedAt: string;
  subject: string;
  body: string;
  refNames: string[];
  files: CommitFileChange[];
  /** Aggregate counts across non-binary files. */
  totals: { files: number; additions: number; deletions: number; binary: number };
  /** `true` when the file list was capped; `files` holds only the current page. */
  truncated: boolean;
  /** Index of the first file in `files`, mirroring the requested `fileCursor`. */
  fileCursor: number;
  /** `fileCursor` for the next page, or `null` when the list is exhausted. */
  nextFileCursor: number | null;
}

/** Discriminated union of every git action the webview may request. */
export type GitActionRequest =
  | { action: 'checkout-branch'; branch: string }
  | { action: 'checkout-commit'; hash: string }
  | { action: 'create-branch'; name: string; startPoint: string }
  | { action: 'merge'; branch: string; noFf?: boolean }
  | { action: 'merge-into'; target: string; source: string }
  | { action: 'revert'; hash: string }
  | { action: 'reset-soft'; hash: string }
  | { action: 'reset-hard'; hash: string }
  | { action: 'push'; remote: string; branch: string; setUpstream?: boolean }
  | { action: 'push-up-to'; remote: string; branch: string; hash: string }
  | { action: 'fetch'; remote?: string; prune?: boolean }
  | { action: 'stash'; message: string; includeUntracked?: boolean }
  | { action: 'stash-pop' }
  | { action: 'merge-continue' }
  | { action: 'merge-abort' };

// ---------------------------------------------------------------- payloads

/**
 * Fields every mutation carries. `idempotencyKey` lets the host replay the
 * previous result instead of re-executing (PRD Kasus 2: double-click push).
 * `confirm` / `forceAcknowledgement` are checked host-side, so a webview cannot
 * bypass the safety guard by omitting them.
 */
export interface MutationMeta {
  idempotencyKey: string;
  confirm?: boolean;
  forceAcknowledgement?: boolean;
  /**
   * Status fingerprint the action was computed against.
   *
   * Optional so a caller that has no snapshot to speak of can still act, but when
   * present the host rejects a mismatch with 409 — exactly as `actions/stage` and
   * `actions/commit` already do through their required `statusToken`. The webview
   * always supplies it, including on a guard-confirmation retry, so confirming a
   * dialog cannot act on the repository the user saw a minute ago.
   */
  statusToken?: string;
}

export interface StatusPayload {
  includeIgnored?: boolean;
}

export interface GraphPayload {
  limit?: number;
  /** Opaque page cursor; currently the number of commits to skip. */
  cursor?: number;
  laneHeight?: number;
  columnWidth?: number;
  rowHeight?: number;
  laneWidth?: number;
}

export interface CommitDetailPayload {
  hash: string;
  /**
   * Skip this many files before filling `CommitDetail.files`.
   *
   * Added for the webview: a truncated diff must offer "Muat lebih banyak", and
   * nothing else in the contract can page a commit's file list. The host honours
   * it and reports the next page through `CommitDetail.nextFileCursor`.
   */
  fileCursor?: number;
}

export interface StagePayload extends MutationMeta {
  paths: string[];
  /** `true` stages, `false` unstages. */
  stage: boolean;
  statusToken: string;
}

export interface CommitPayload extends MutationMeta {
  message: string;
  amend?: boolean;
  /** Push the current branch right after a successful commit. */
  push?: boolean;
  statusToken: string;
}

export type GitActionPayload = GitActionRequest & MutationMeta;

export interface SettingsGetPayload {
  keys?: string[];
}

export interface SettingsSetPayload {
  key: string;
  value: string | number | boolean;
}

export interface GitHubRepoPayload {
  owner: string;
  repo: string;
}

/**
 * Open a file diff in a real VS Code diff editor.
 *
 * Added for the webview Inspector: a file row must open the editor rather than
 * do nothing. `hash` selects the commit (omit for the working tree), `parent`
 * picks which parent a merge commit is compared against.
 *
 * There is deliberately no "mode" field: a conflicted path opens the merge
 * editor and a working-tree path picks index-vs-HEAD or worktree-vs-index, both
 * decided host-side from the live status. A webview-supplied mode would be a
 * second source of truth that could disagree with the repository.
 */
export interface OpenDiffPayload {
  path: string;
  hash?: string;
  parent?: string;
}

export interface OpenDiffResult {
  opened: boolean;
  /** What the host actually opened, so the UI can label the result. */
  mode: 'commit' | 'index' | 'worktree' | 'merge';
}

/**
 * One configured git remote.
 *
 * Added for the webview: the node menu may only offer "Buka di GitHub" when a
 * GitHub remote actually exists, which requires the remote URL. Nothing else in
 * the contract exposes it.
 *
 * URLs are credential-stripped host-side, so a remote configured with an
 * embedded token never reaches the webview with the secret attached.
 */
export interface RemoteInfo {
  name: string;
  fetchUrl: string;
  pushUrl: string;
  /** Parsed host, or `null` when the URL is not an `owner/repo` remote. */
  host: string | null;
  owner: string | null;
  repo: string | null;
  isGitHub: boolean;
}

export interface ActionResult {
  ok: true;
  operation: OperationState;
  statusToken: string;
}

/**
 * Commit outcome. When `push` was requested and failed, the commit stands:
 * `pushed: false` plus `pushError` so the UI can offer "Retry Push".
 */
export interface CommitResult {
  success: true;
  commit: string | null;
  pushed: boolean;
  pushError?: string;
  operation: OperationState;
  statusToken: string;
}

/** Per-workspace UI preferences persisted in `workspaceState`. Never tokens. */
export interface UiPreferences {
  zoom: number;
  branchFilter: string;
}

export interface SettingsSnapshot {
  gitPath: string;
  commitLimit: number;
  pageSize: number;
  showIgnoredFiles: boolean;
  githubApiUrl: string;
  fetchStalenessMs: number;
  language: 'en' | 'id';
  ui: UiPreferences;
}

export interface GitHubAuthState {
  connected: boolean;
  login: string | null;
  scopes: string[];
  /**
   * `true` when a token was stored but the API rejected it. The host deletes the
   * token in that case, so this is a one-shot report, not a persistent state.
   */
  invalidToken?: boolean;
  /** Present when the token lacks `repo:status` and the repository is private. */
  scopeWarning?: string;
  /** API base actually in use, so the UI can show which host it talked to. */
  apiUrl?: string;
}

/**
 * Rate-limit snapshot taken from the last GitHub response.
 *
 * `cached` means the payload came from the in-memory response cache, `offline`
 * means the circuit breaker is open. Both are shown as badges, so the user can
 * tell fresh data from a replay.
 */
export interface GitHubRateLimit {
  limit: number | null;
  remaining: number | null;
  /** Epoch ms at which the window resets, or `null` when unknown. */
  resetAt: number | null;
  cached: boolean;
  offline: boolean;
}

export interface GitHubRepoInfo {
  defaultBranch: string;
  private: boolean;
  htmlUrl: string;
  rateLimit: GitHubRateLimit;
  /** Set when the repository is private and the token lacks `repo:status`. */
  scopeWarning?: string;
}

export interface PullRequestInfo {
  number: number;
  title: string;
  state: 'open' | 'closed' | 'merged';
  url: string;
  headRef: string;
  baseRef: string;
  draft: boolean;
  author: string;
  updatedAt: string;
}

export interface PullRequestsPayload {
  owner: string;
  repo: string;
  /** Default `open`, per the PRD. */
  state?: 'open' | 'closed' | 'all';
}

export interface PullRequestsResult {
  pullRequests: PullRequestInfo[];
  rateLimit: GitHubRateLimit;
}

export interface CommitAuthorInfo {
  hash: string;
  login: string | null;
  avatarUrl: string | null;
}

export interface CommitAuthorsPayload {
  owner: string;
  repo: string;
  hashes: string[];
}

/**
 * Commit authors result carrying resolved avatar URLs and logins.
 *
 * Rate-limit snapshot included so author avatar fetching reports cache and
 * quota state consistently with pullRequests and repo queries.
 */
export interface CommitAuthorsResult {
  authors: CommitAuthorInfo[];
  rateLimit: GitHubRateLimit;
}

/**
 * GitHub linkage for the active repository's detected remote.
 *
 * `commitUrlTemplate` carries a literal `{hash}` placeholder so the UI can build
 * a per-commit link without knowing the host layout.
 */
export interface GitHubLinkage {
  available: boolean;
  host: string | null;
  owner: string | null;
  repo: string | null;
  webUrl: string | null;
  commitUrlTemplate: string | null;
  /** API base derived for this remote, including the Enterprise `/api/v3` rule. */
  apiUrl: string | null;
}

/** Ask the host to open a URL externally. Only `https:` GitHub links are honoured. */
export interface OpenExternalPayload {
  url: string;
}

/** Request kind → { payload, response } map. Extend here, nowhere else. */
export interface RequestMap {
  'repos/status': { payload: StatusPayload; response: RepoStatus };
  'repos/graph': { payload: GraphPayload; response: RepoGraph };
  'repos/remotes': { payload: Record<string, never>; response: { remotes: RemoteInfo[] } };
  'commits/detail': { payload: CommitDetailPayload; response: CommitDetail };
  'actions/stage': { payload: StagePayload; response: ActionResult };
  'actions/commit': { payload: CommitPayload; response: CommitResult };
  'actions/git': { payload: GitActionPayload; response: ActionResult };
  'actions/openDiff': { payload: OpenDiffPayload; response: OpenDiffResult };
  /**
   * Reveal the `Git Control` output channel. Empty payload by design: it takes no
   * parameters, so it cannot be used to run an arbitrary host command.
   */
  'actions/showLogs': { payload: Record<string, never>; response: { shown: boolean } };
  /**
   * Open the Git Control explorer webview panel. Empty payload by design: it takes no
   * parameters, so it cannot be used to run an arbitrary host command.
   */
  'actions/openExplorer': { payload: Record<string, never>; response: { opened: boolean } };
  /** Open a URL in the system browser. Host-side only; the webview cannot navigate. */
  'actions/openExternal': { payload: OpenExternalPayload; response: { opened: boolean } };
  'github/auth': { payload: Record<string, never>; response: GitHubAuthState };
  'github/connect': { payload: Record<string, never>; response: GitHubAuthState };
  'github/disconnect': { payload: Record<string, never>; response: GitHubAuthState };
  'github/repo': { payload: GitHubRepoPayload; response: GitHubRepoInfo };
  'github/pullRequests': { payload: PullRequestsPayload; response: PullRequestsResult };
  /**
   * Fetch author profile avatars and logins for a set of commit hashes.
   * Host-side metadata query so the webview can decorate commit authors with
   * GitHub avatars without making direct network calls or managing auth tokens.
   */
  'github/commitAuthors': { payload: CommitAuthorsPayload; response: CommitAuthorsResult };
  'github/linkage': { payload: Record<string, never>; response: GitHubLinkage };
  'settings/get': { payload: SettingsGetPayload; response: SettingsSnapshot };
  'settings/set': { payload: SettingsSetPayload; response: SettingsSnapshot };
}

export type RequestKind = keyof RequestMap;
export type RequestPayload<K extends RequestKind> = RequestMap[K]['payload'];
export type ResponseData<K extends RequestKind> = RequestMap[K]['response'];

export interface Request<K extends RequestKind = RequestKind> {
  id: string;
  kind: K;
  payload: RequestPayload<K>;
}

export type Response<K extends RequestKind = RequestKind> =
  | { id: string; ok: true; data: ResponseData<K> }
  | { id: string; ok: false; error: ErrorBody };

// ----------------------------------------------------- host → webview events

export interface ToastEvent {
  level: 'info' | 'warning' | 'error';
  message: string;
  detail?: string;
}

export interface OperationProgressEvent {
  /** Correlates with the request id that started the operation. */
  id: string;
  operation: string;
  phase: 'started' | 'progress' | 'finished' | 'failed';
  message?: string;
}

export interface RepoChangedEvent {
  reason: 'fs' | 'action' | 'manual';
  statusToken: string;
}

/** Event kind → payload map for unsolicited host pushes. */
export interface EventMap {
  'event/repoChanged': RepoChangedEvent;
  'event/operationProgress': OperationProgressEvent;
  'event/toast': ToastEvent;
  'event/settingsChanged': SettingsSnapshot;
}

export type EventKind = keyof EventMap;

export interface HostEvent<K extends EventKind = EventKind> {
  kind: K;
  payload: EventMap[K];
}

/** Union of everything the webview can receive. */
export type HostMessage = Response | HostEvent;

/** Narrow a received host message to an event. */
export function isHostEvent(message: HostMessage): message is HostEvent {
  return 'kind' in message;
}

/** Typed client surface implemented by the webview bridge. */
export interface Bridge {
  request<K extends RequestKind>(kind: K, payload: RequestPayload<K>): Promise<ResponseData<K>>;
  on<K extends EventKind>(kind: K, handler: (payload: EventMap[K]) => void): () => void;
}
