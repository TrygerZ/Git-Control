import type { ErrorBody } from './messages';

/** Preserve the common transport fallback without coupling host and webview error handling. */
export function unknownErrorBody(err: unknown): ErrorBody {
  return {
    status: 500,
    code: 'SERVER_ERROR',
    message: err instanceof Error ? err.message : String(err),
  };
}
