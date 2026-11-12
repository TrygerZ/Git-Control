import type { ErrorCode, GitActionPayload, IssueListFilter, IssueStateFilter, Request, RequestKind } from './messages';
import { validateBranchName, validateHash, validateRemoteName, validateRepoRelativePath, validateStashIndex } from './validation';

export type Outcome = { ok: true; data: unknown } | { ok: false; error: { code: ErrorCode } };
export const MUTATION_KINDS = new Set<string>(['actions/stage', 'actions/commit', 'actions/git']);
/**
 * GitHub mutations. Empty until the endpoint phases (P22 to P28) register one;
 * the set exists now so `idempotencyKeyOf` has a single place to consult and a
 * later phase cannot add a kind to only one of the two sets.
 */
export const GITHUB_MUTATION_KINDS = new Set<string>();
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
    default: fail('action');
  }
}

export function messageOf(err: unknown): string { return err instanceof Error ? err.message : String(err); }
export function isPositiveInt(value: unknown): boolean { return typeof value === 'number' && Number.isInteger(value) && value > 0; }
export function isNonNegativeInt(value: unknown): boolean { return typeof value === 'number' && Number.isInteger(value) && value >= 0; }
export function isSlug(value: unknown): boolean {
  return typeof value === 'string' && value.length > 0 && value.length <= 100 && /^[A-Za-z0-9._-]+$/.test(value);
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
