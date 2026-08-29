/**
 * Typed message contract between the extension host and the webview.
 * Request kinds mirror the PRD's REST-equivalent endpoints. Fully typed so
 * `bridge.request('repos/graph', payload)` infers the response shape. No `any`.
 */

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
  | 'HOOK_REJECTED';

export interface ErrorBody {
  status: number;
  code: ErrorCode;
  message: string;
  detail?: string;
}

// ------------------------------------------------------------- domain DTOs

export type OperationState = 'idle' | 'merge' | 'rebase' | 'cherry-pick' | 'revert' | 'bisect';

export interface RefInfo {
  /** Full ref name, e.g. `refs/heads/main`. */
  refName: string;
  /** Short display name, e.g. `main` or `origin/main`. */
  shortName: string;
  kind: 'local' | 'remote' | 'tag';
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
  operation: OperationState;
  changes: ChangeEntry[];
  conflicts: ConflictEntry[];
  /** Server-computed token used to reject actions built on stale status. */
  statusToken: string;
  lastFetchedAt: string | null;
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

export interface RepoGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  lanes: GraphLane[];
  refs: RefInfo[];
  head: string | null;
  truncated: boolean;
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
}

/** Discriminated union of every git action the webview may request. */
export type GitActionRequest =
  | { action: 'checkout-branch'; branch: string }
  | { action: 'checkout-commit'; hash: string }
  | { action: 'create-branch'; name: string; startPoint: string }
  | { action: 'merge'; branch: string; noFf?: boolean }
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

export interface StatusPayload {
  includeIgnored?: boolean;
}

export interface GraphPayload {
  limit?: number;
  skip?: number;
  rowHeight?: number;
  laneWidth?: number;
}

export interface CommitDetailPayload {
  hash: string;
}

export interface StagePayload {
  paths: string[];
  /** `true` stages, `false` unstages. */
  stage: boolean;
  statusToken: string;
}

export interface CommitPayload {
  message: string;
  amend?: boolean;
  statusToken: string;
}

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

export interface ActionResult {
  ok: true;
  operation: OperationState;
  statusToken: string;
}

export interface SettingsSnapshot {
  gitPath: string;
  commitLimit: number;
  pageSize: number;
  showIgnoredFiles: boolean;
  githubApiUrl: string;
  fetchStalenessMs: number;
}

export interface GitHubAuthState {
  connected: boolean;
  login: string | null;
  scopes: string[];
}

/** Request kind → { payload, response } map. Extend here, nowhere else. */
export interface RequestMap {
  'repos/status': { payload: StatusPayload; response: RepoStatus };
  'repos/graph': { payload: GraphPayload; response: RepoGraph };
  'commits/detail': { payload: CommitDetailPayload; response: CommitDetail };
  'actions/stage': { payload: StagePayload; response: ActionResult };
  'actions/commit': { payload: CommitPayload; response: ActionResult };
  'actions/git': { payload: GitActionRequest; response: ActionResult };
  'github/auth': { payload: Record<string, never>; response: GitHubAuthState };
  'github/connect': { payload: Record<string, never>; response: GitHubAuthState };
  'github/disconnect': { payload: Record<string, never>; response: GitHubAuthState };
  'github/repo': { payload: GitHubRepoPayload; response: { defaultBranch: string; private: boolean } };
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
