/**
 * Pure runtime type guards for host-to-webview messages.
 *
 * Validates payload shapes before dispatching events to store listeners
 * or resolving/rejecting pending requests in the webview bridge (SEC-W1).
 */
import type {
  CommitFocusEvent,
  HostEvent,
  IconThemeSnapshot,
  OperationProgressEvent,
  RepoChangedEvent,
  Response,
  SettingsSnapshot,
  ToastEvent,
} from '../messages';

/** Validates that an unknown value is a record-like object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Pure field-by-field validator for `event/repoChanged`. */
export function isValidRepoChanged(payload: unknown): payload is RepoChangedEvent {
  if (!isRecord(payload)) return false;
  const { reason, statusToken } = payload;
  return (
    (reason === 'fs' || reason === 'action' || reason === 'manual') &&
    typeof statusToken === 'string'
  );
}

/** Pure field-by-field validator for `event/operationProgress`. */
export function isValidOperationProgress(payload: unknown): payload is OperationProgressEvent {
  if (!isRecord(payload)) return false;
  const { id, operation, phase, message } = payload;
  const validPhases = new Set(['started', 'progress', 'finished', 'failed']);
  return (
    typeof id === 'string' &&
    id.length > 0 &&
    typeof operation === 'string' &&
    typeof phase === 'string' &&
    validPhases.has(phase) &&
    (message === undefined || typeof message === 'string')
  );
}

/** Pure field-by-field validator for `event/toast`. */
export function isValidToast(payload: unknown): payload is ToastEvent {
  if (!isRecord(payload)) return false;
  const { level, message, detail } = payload;
  return (
    (level === 'info' || level === 'warning' || level === 'error') &&
    typeof message === 'string' &&
    (detail === undefined || typeof detail === 'string')
  );
}

/** Pure field-by-field validator for `event/settingsChanged`. */
export function isValidSettingsSnapshot(payload: unknown): payload is SettingsSnapshot {
  if (!isRecord(payload)) return false;
  const {
    gitPath,
    commitLimit,
    pageSize,
    showIgnoredFiles,
    githubApiUrl,
    fetchStalenessMs,
    language,
    ui,
  } = payload;
  return (
    typeof gitPath === 'string' &&
    typeof commitLimit === 'number' &&
    typeof pageSize === 'number' &&
    typeof showIgnoredFiles === 'boolean' &&
    typeof githubApiUrl === 'string' &&
    typeof fetchStalenessMs === 'number' &&
    (language === 'en' || language === 'id') &&
    isRecord(ui) &&
    typeof (ui as Record<string, unknown>).zoom === 'number' &&
    typeof (ui as Record<string, unknown>).branchFilter === 'string'
  );
}

/** Pure field-by-field validator for `event/iconThemeChanged`. */
export function isValidIconTheme(payload: unknown): payload is IconThemeSnapshot | null {
  if (payload === null) return true;
  if (!isRecord(payload)) return false;
  const { themeId, definitions, fonts } = payload;
  return (
    typeof themeId === 'string' &&
    isRecord(definitions) &&
    Array.isArray(fonts)
  );
}

/** Pure field-by-field validator for `event/commitFocus`. */
export function isValidCommitFocus(payload: unknown): payload is CommitFocusEvent {
  if (!isRecord(payload)) return false;
  const { hash } = payload;
  return typeof hash === 'string' && hash.length > 0;
}

/**
 * Validate and narrow an arbitrary host event message.
 * Returns the typed HostEvent if kind is known and payload matches its contract;
 * returns null otherwise.
 */
export function validateHostEvent(raw: unknown): HostEvent | null {
  if (!isRecord(raw)) return null;
  const { kind, payload } = raw;
  if (typeof kind !== 'string') return null;

  switch (kind) {
    case 'event/repoChanged':
      return isValidRepoChanged(payload) ? { kind, payload } : null;
    case 'event/operationProgress':
      return isValidOperationProgress(payload) ? { kind, payload } : null;
    case 'event/toast':
      return isValidToast(payload) ? { kind, payload } : null;
    case 'event/settingsChanged':
      return isValidSettingsSnapshot(payload) ? { kind, payload } : null;
    case 'event/iconThemeChanged':
      return isValidIconTheme(payload) ? { kind, payload } : null;
    case 'event/commitFocus':
      return isValidCommitFocus(payload) ? { kind, payload } : null;
    default:
      return null;
  }
}

/**
 * Validate that an incoming message has a valid Response shape.
 * Enforces id: string (non-empty), ok: boolean.
 * When ok is false, enforces error: ErrorBody with code: string (non-empty) and message: string.
 */
export function isValidResponse(raw: unknown): raw is Response {
  if (!isRecord(raw)) return false;
  const { id, ok, error, kind } = raw;
  // A response cannot carry an event kind
  if (kind !== undefined) return false;
  if (typeof id !== 'string' || id.length === 0) return false;
  if (typeof ok !== 'boolean') return false;

  if (ok) {
    return error === undefined;
  }

  if (!isRecord(error)) return false;
  const { code, message } = error;
  return typeof code === 'string' && code.length > 0 && typeof message === 'string';
}
