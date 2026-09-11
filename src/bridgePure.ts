import type { ErrorCode, GitActionPayload, Request, RequestKind } from './messages';
import { validateBranchName, validateHash, validateRemoteName, validateRepoRelativePath, validateStashIndex } from './validation';

export type Outcome = { ok: true; data: unknown } | { ok: false; error: { code: ErrorCode } };
export const MUTATION_KINDS = new Set<string>(['actions/stage', 'actions/commit', 'actions/git']);
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
  if (!MUTATION_KINDS.has(request.kind)) return null;
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
    default: fail('action');
  }
}

export function messageOf(err: unknown): string { return err instanceof Error ? err.message : String(err); }
export function isPositiveInt(value: unknown): boolean { return typeof value === 'number' && Number.isInteger(value) && value > 0; }
export function isNonNegativeInt(value: unknown): boolean { return typeof value === 'number' && Number.isInteger(value) && value >= 0; }
export function isSlug(value: unknown): boolean {
  return typeof value === 'string' && value.length > 0 && value.length <= 100 && /^[A-Za-z0-9._-]+$/.test(value);
}
