import { validatePullRequestInput } from './pullRequestDraft';
import type { ErrorCode, GitActionPayload, IssueListFilter, IssueStateFilter, Request, RequestKind } from './messages';
import { validateBranchName, validateHash, validatePullRequestNumber, validateRemoteName, validateRepoRelativePath, validateStashIndex } from './validation';

export type Outcome = { ok: true; data: unknown } | { ok: false; error: { code: ErrorCode } };
export const MUTATION_KINDS = new Set<string>(['actions/stage', 'actions/commit', 'actions/git']);
/**
 * GitHub mutations. P22 registers the first one; later phases add theirs here so
 * `idempotencyKeyOf` keeps a single place to consult.
 */
export const GITHUB_MUTATION_KINDS = new Set<string>(['github/createPullRequest']);
const RETRYABLE_CODES = new Set<ErrorCode>([
  'CONFIRMATION_REQUIRED',
  'DIRTY_TREE',
  'STALE_STATUS',
  'REMOTE_AHEAD',
  'NON_FAST_FORWARD',
]);

export function parseRequest(raw: unknown): Request | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const candidate = raw as { id?: unknown; kind?: unknown; payload?: unknown };
  if (typeof candidate.id !== 'string' || candidate.id.length === 0) return null;
  if (typeof candidate.kind !== 'string') return null;
  if (typeof candidate.payload !== 'object' || candidate.payload === null) return null;
  return { id: candidate.id, kind: candidate.kind as RequestKind, payload: candidate.payload as Request['payload'] };
}

export function idempotencyKeyOf(request: Request): string | null {
  if (!MUTATION_KINDS.has(request.kind) && !GITHUB_MUTATION_KINDS.has(request.kind)) return null;
  const payload = request.payload as { idempotencyKey?: unknown };
  if (typeof payload.idempotencyKey !== 'string' || payload.idempotencyKey.length === 0) return null;
  return `${request.kind}:${payload.idempotencyKey}`;
}

export function shouldRemember(outcome: Outcome): boolean {
  return outcome.ok || !RETRYABLE_CODES.has(outcome.error.code);
}

export function validateEmptyPayload(payload: object, fail: (detail: string) => never): void {
  if (Object.keys(payload).length > 0) fail('payload');
}

export function validateAction(action: GitActionPayload, fail: (detail: string) => never): void {
  switch (action.action) {
    case 'checkout-branch': if (!validateBranchName(action.branch)) fail('branch'); return;
    case 'checkout-commit': case 'revert': case 'reset-soft': case 'reset-hard': case 'cherry-pick':
      if (!validateHash(action.hash)) fail('hash'); return;
    case 'create-branch':
      if (!validateBranchName(action.name)) fail('name');
      if (!validateBranchName(action.startPoint) && !validateHash(action.startPoint)) fail('startPoint'); return;
    case 'merge': if (!validateBranchName(action.branch)) fail('branch'); return;
    case 'merge-into':
      if (!validateBranchName(action.target)) fail('target');
      if (!validateBranchName(action.source) && !validateHash(action.source)) fail('source'); return;
    case 'push':
      if (!validateRemoteName(action.remote)) fail('remote');
      if (!validateBranchName(action.branch)) fail('branch'); return;
    case 'push-up-to':
      if (!validateRemoteName(action.remote)) fail('remote');
      if (!validateBranchName(action.branch)) fail('branch');
      if (!validateHash(action.hash)) fail('hash'); return;
    case 'pull':
      if (action.remote !== undefined && !validateRemoteName(action.remote)) fail('remote');
      if (action.branch !== undefined && !validateBranchName(action.branch)) fail('branch');
      return;
    case 'fetch': if (action.remote !== undefined && !validateRemoteName(action.remote)) fail('remote'); return;
    case 'stash': if (typeof action.message !== 'string') fail('message'); return;
    case 'discard-file': if (!validateRepoRelativePath(action.path)) fail('path'); return;
    case 'stash-pop': case 'merge-continue': case 'merge-abort': case 'cherry-pick-continue': case 'cherry-pick-abort': return;
    case 'stash-apply':
    case 'stash-drop':
      if (!validateStashIndex(action.index)) fail('index'); return;
    case 'branch-delete':
      if (!validateBranchName(action.branch)) fail('branch'); return;
    case 'branch-delete-remote':
      if (!validateRemoteName(action.remote)) fail('remote');
      if (!validateBranchName(action.branch)) fail('branch'); return;
    case 'checkout-pr':
      if (!validatePullRequestNumber(action.number)) fail('number');
      if (action.remote !== undefined && !validateRemoteName(action.remote)) fail('remote'); return;
    default: fail('action');
  }
}

export function messageOf(err: unknown): string { return err instanceof Error ? err.message : String(err); }
export function isPositiveInt(value: unknown): boolean { return typeof value === 'number' && Number.isInteger(value) && value > 0; }
export function isNonNegativeInt(value: unknown): boolean { return typeof value === 'number' && Number.isInteger(value) && value >= 0; }
/**
 * A GitHub owner or repository name. The value is one path segment in every URL
 * built from it, so `.` and `..` are refused: they are the only two names that
 * leave the segment they were placed in.
 */
export function isSlug(value: unknown): boolean {
  return typeof value === 'string' && value.length > 0 && value.length <= 100
    && value !== '.' && value !== '..'
    && !value.startsWith('-') && /^[A-Za-z0-9._-]+$/.test(value);
}
/** A GitHub Actions run or workflow id. Same rule as any other positive integer. */
export function isRunId(value: unknown): boolean {
  return isPositiveInt(value);
}

/**
 * `github/actionsRuns`. `branch` reaches a query string and `workflowId` reaches
 * a path segment, so both are validated with the same rules the git argv uses.
 */
export function validateActionsRunsPayload(
  payload: { owner: unknown; repo: unknown; branch?: unknown; workflowId?: unknown; perPage?: unknown },
  fail: (detail: string) => never,
): void {
  if (!isSlug(payload.owner) || !isSlug(payload.repo)) fail('owner/repo');
  if (payload.branch !== undefined && !validateBranchName(payload.branch)) fail('branch');
  if (payload.workflowId !== undefined && !isPositiveInt(payload.workflowId)) fail('workflowId');
  if (payload.perPage !== undefined && (!isPositiveInt(payload.perPage) || (payload.perPage as number) > 50)) {
    fail('perPage');
  }
}

/** `github/actionsJobs`. The run id is the only variable part of the path. */
export function validateActionsJobsPayload(
  payload: { owner: unknown; repo: unknown; runId: unknown },
  fail: (detail: string) => never,
): void {
  if (!isSlug(payload.owner) || !isSlug(payload.repo)) fail('owner/repo');
  if (!isRunId(payload.runId)) fail('runId');
}

/** `github/actionsLog`. The job id is the only variable part of the path. */
export function validateActionsLogPayload(
  payload: { owner: unknown; repo: unknown; jobId: unknown; completed?: unknown },
  fail: (detail: string) => never,
): void {
  if (!isSlug(payload.owner) || !isSlug(payload.repo)) fail('owner/repo');
  if (!isPositiveInt(payload.jobId)) fail('jobId');
  if (payload.completed !== undefined && typeof payload.completed !== 'boolean') fail('completed');
}

export function isIssueFilter(value: unknown): value is IssueListFilter {
  return value === 'assigned' || value === 'created' || value === 'mentioned';
}
export function isIssueState(value: unknown): value is IssueStateFilter {
  return value === 'open' || value === 'closed';
}

/** `github/commitPullRequests`. `hash` reaches a path segment of the commit. */
export function validateCommitPullRequestsPayload(
  payload: { owner: unknown; repo: unknown; hash: unknown },
  fail: (detail: string) => never,
): void {
  if (!isSlug(payload.owner) || !isSlug(payload.repo)) fail('owner/repo');
  if (!validateHash(payload.hash)) fail('hash');
}

/** `github/checkRuns`. `sha` reaches a path segment of the commit. */
export function validateCheckRunsPayload(
  payload: { owner: unknown; repo: unknown; sha: unknown },
  fail: (detail: string) => never,
): void {
  if (!isSlug(payload.owner) || !isSlug(payload.repo)) fail('owner/repo');
  if (!validateHash(payload.sha)) fail('sha');
}

/**
 * `github/prPrepare`. `base` is optional: the host falls back to the repository
 * default branch, which the webview cannot know before the first response.
 */
export function validatePrPreparePayload(
  payload: { owner: unknown; repo: unknown; base?: unknown },
  fail: (detail: string) => never,
): void {
  if (!isSlug(payload.owner) || !isSlug(payload.repo)) fail('owner/repo');
  if (payload.base !== undefined && !validateBranchName(payload.base)) fail('base');
}

/** `github/prReviewers`. Only the slug pair; the host derives everything else. */
export function validatePrReviewersPayload(
  payload: { owner: unknown; repo: unknown },
  fail: (detail: string) => never,
): void {
  if (!isSlug(payload.owner) || !isSlug(payload.repo)) fail('owner/repo');
}

/**
 * `github/createPullRequest`. The one payload in this phase that reaches an
 * argv-adjacent surface: `head` becomes the refspec of the publish push, so it is
 * held to the same branch rule the git layer applies.
 */
export function validateCreatePullRequestPayload(
  payload: {
    owner: unknown;
    repo: unknown;
    base: unknown;
    head: unknown;
    title: unknown;
    body: unknown;
    draft: unknown;
    reviewers: unknown;
    publish: unknown;
    remote?: unknown;
  },
  fail: (detail: string) => never,
): void {
  if (!isSlug(payload.owner) || !isSlug(payload.repo)) fail('owner/repo');
  if (!validateBranchName(payload.base)) fail('base');
  if (!validateBranchName(payload.head)) fail('head');
  if (payload.head === payload.base) fail('head');
  // Title, body, and reviewer rules live in one place. The casts are honest:
  // `validatePullRequestInput` re-checks every type itself and never coerces.
  const verdict = validatePullRequestInput({
    title: payload.title as string,
    body: payload.body as string,
    base: payload.base as string,
    head: payload.head as string,
    reviewers: payload.reviewers as readonly string[],
  });
  // Reviewers are reported last, after the three fields this payload adds, so
  // the dialog focuses them in the order it draws them.
  if (!verdict.ok && verdict.field !== 'reviewers') fail(verdict.field);
  if (typeof payload.draft !== 'boolean') fail('draft');
  if (typeof payload.publish !== 'boolean') fail('publish');
  if (payload.remote !== undefined && !validateRemoteName(payload.remote)) fail('remote');
  if (!verdict.ok) fail(verdict.field);
}
