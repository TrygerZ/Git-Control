/**
 * Structured logging for the extension host.
 *
 * No `vscode` import: the output sink is injected so the redactor and the line
 * formatter stay unit-testable. `extension.ts` passes an OutputChannel.
 *
 * Redaction is applied to every line before it reaches the sink. Diff content
 * and file contents are never passed to this logger in the first place; the
 * patterns below are the second line of defense for values that travel through
 * git stderr (remote URLs, HTTP headers, token echoes).
 */

/** Minimal sink contract, satisfied by `vscode.OutputChannel`. */
export interface LogSink {
  appendLine(value: string): void;
}

export type LogStatus = 'start' | 'ok' | 'fail' | 'info';

export interface LogRecord {
  /** Operation id correlating a start line with its terminal line. */
  operationId: string;
  kind: string;
  status: LogStatus;
  durationMs?: number;
  exitCode?: number | null;
  detail?: string;
}

const REDACTED = '[redacted]';

/**
 * Ordered redaction rules. Each replaces the secret portion only, so the
 * surrounding text stays useful for debugging.
 *
 * Deliberate omission: a bare 40-hex classic OAuth token is NOT matched, because
 * it is byte-identical to a git object id and this log is full of those.
 * Redacting every 40-hex run would erase every hash from the output channel. The
 * two paths a token can actually reach a log line — a remote URL's userinfo and
 * an HTTP auth header — are both covered below.
 */
const RULES: ReadonlyArray<{ pattern: RegExp; replace: string }> = [
  // GitHub PAT / OAuth / user-to-server / server-to-server / refresh tokens.
  { pattern: /gh[pousr]_[A-Za-z0-9]{20,}/g, replace: REDACTED },
  // Fine-grained PAT: different prefix, different length, and underscores in the
  // body, so the rule above does not cover it.
  { pattern: /github_pat_[A-Za-z0-9_]{20,}/g, replace: REDACTED },
  // `x-access-token:<token>@host`, with or without a scheme prefix.
  { pattern: /x-access-token:[^@\s]*@/gi, replace: `x-access-token:${REDACTED}@` },
  // Any other `user:password@host` credential in a URL. The username is kept
  // (it is not a secret and helps debugging); only the password is dropped.
  //
  // Userinfo runs to the LAST `@` before the path, so an email-style username or
  // a secret that itself contains `@` cannot leave its tail behind.
  // Idempotent, so it safely runs over the rule above.
  { pattern: /(\bhttps?:\/\/)([^/\s:@]+)[:@][^/\s]*@/gi, replace: `$1$2:${REDACTED}@` },
  // Bare auth credentials, e.g. a `Bearer …` echoed without its header name.
  { pattern: /\b(Bearer|Basic|token)\s+[A-Za-z0-9._\-+/=]{16,}/gi, replace: `$1 ${REDACTED}` },
  // HTTP auth headers, however they are cased or spaced.
  { pattern: /(Authorization:\s*)\S+.*/gi, replace: `$1${REDACTED}` },
];

/** Strip credentials from an arbitrary string. Pure; safe on empty input. */
export function redact(value: string): string {
  let out = value;
  for (const rule of RULES) out = out.replace(rule.pattern, rule.replace);
  return out;
}

/** Render one log line. Exported for the formatter test. */
export function formatRecord(record: LogRecord, now: Date): string {
  const parts = [
    now.toISOString(),
    record.operationId,
    record.kind,
    record.status,
  ];
  if (record.durationMs !== undefined) parts.push(`${Math.round(record.durationMs)}ms`);
  if (record.exitCode !== undefined && record.exitCode !== null) parts.push(`exit=${record.exitCode}`);
  const line = parts.join(' ');
  const detail = record.detail === undefined ? '' : ` ${collapse(record.detail)}`;
  return redact(`${line}${detail}`);
}

/** Single-line a multi-line detail so one record never spans several lines. */
function collapse(value: string): string {
  return value.replace(/\s*[\r\n]+\s*/g, ' | ').trim();
}

export class Logger {
  private readonly sink: LogSink;
  private readonly clock: () => Date;
  private counter = 0;

  constructor(sink: LogSink, clock: () => Date = () => new Date()) {
    this.sink = sink;
    this.clock = clock;
  }

  /** Fresh operation id. Monotonic per session, no randomness needed. */
  nextOperationId(): string {
    this.counter += 1;
    return `op-${String(this.counter).padStart(5, '0')}`;
  }

  log(record: LogRecord): void {
    this.sink.appendLine(formatRecord(record, this.clock()));
  }

  info(kind: string, detail?: string): void {
    this.log({
      operationId: '-',
      kind,
      status: 'info',
      ...(detail === undefined ? {} : { detail }),
    });
  }

  /**
   * Time an operation, emitting a `start` line and a terminal `ok`/`fail` line.
   * Rethrows so callers keep their own error handling.
   */
  async time<T>(operationId: string, kind: string, fn: () => Promise<T>): Promise<T> {
    const started = Date.now();
    this.log({ operationId, kind, status: 'start' });
    try {
      const result = await fn();
      this.log({ operationId, kind, status: 'ok', durationMs: Date.now() - started });
      return result;
    } catch (err) {
      this.log({
        operationId,
        kind,
        status: 'fail',
        durationMs: Date.now() - started,
        ...exitCodeOf(err),
        detail: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }
}

/** Pull `exitCode` off a GitError-shaped value without importing git.ts. */
function exitCodeOf(err: unknown): { exitCode?: number } {
  if (typeof err === 'object' && err !== null && 'exitCode' in err) {
    const code = (err as { exitCode: unknown }).exitCode;
    if (typeof code === 'number') return { exitCode: code };
  }
  return {};
}
