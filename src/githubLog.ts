/**
 * Job log processing (P14).
 *
 * The log body arrives from a signed storage URL and is untrusted: it can carry
 * ANSI escapes, carriage-return progress bars, PEM key material, and secrets.
 * Everything here is pure (no `vscode`, no network, no clock) so the pipeline and
 * the redirect host policy are unit-testable.
 *
 * Order matters. Masking runs before the line cut so a PEM block whose BEGIN line
 * sits outside the kept window cannot leak its body inside it.
 */
import { redact } from './logger';
import type { LogLine, LogState } from './messages';

export interface LogLimits {
  /** Rolling window kept in memory, in bytes. */
  tailBytes: number;
  /** Abort the download past this many bytes. */
  hardCapBytes: number;
  maxLines: number;
  maxLineChars: number;
  /** Total characters sent to the webview. */
  maxChars: number;
}

export const DEFAULT_LOG_LIMITS: LogLimits = {
  tailBytes: 1024 * 1024,
  hardCapBytes: 64 * 1024 * 1024,
  maxLines: 200,
  maxLineChars: 1000,
  maxChars: 32768,
};

/** Placeholder for masked key material. The caller injects the localized text. */
export const DEFAULT_MASKED_TEXT = '[masked key material]';

/**
 * Rolling window over a byte stream.
 *
 * Bounded on both ends: `tailBytes` caps what is held in memory, `hardCapBytes`
 * caps what is read at all, so a hostile multi-gigabyte body costs bandwidth only
 * until the cap and then stops.
 */
export class TailBuffer {
  private readonly tailBytes: number;
  private readonly hardCapBytes: number;
  private buffer = new Uint8Array(0);
  private seen = 0;
  private dropped = false;

  constructor(limits: Pick<LogLimits, 'tailBytes' | 'hardCapBytes'>) {
    this.tailBytes = limits.tailBytes;
    this.hardCapBytes = limits.hardCapBytes;
  }

  push(chunk: Uint8Array): 'ok' | 'overflow' {
    if (chunk.length === 0) return 'ok';
    this.seen += chunk.length;
    const combined = new Uint8Array(this.buffer.length + chunk.length);
    combined.set(this.buffer, 0);
    combined.set(chunk, this.buffer.length);
    if (combined.length > this.tailBytes) {
      this.dropped = true;
      this.buffer = combined.slice(combined.length - this.tailBytes);
    } else {
      this.buffer = combined;
    }
    return this.seen > this.hardCapBytes ? 'overflow' : 'ok';
  }

  get total(): number {
    return this.seen;
  }

  get headDropped(): boolean {
    return this.dropped;
  }

  bytes(): Uint8Array {
    return this.buffer;
  }
}

/** C0 controls except tab (0x09). Newlines are already handled by the split. */
const C0_EXCEPT_TAB = /[\u0000-\u0008\u000A-\u001F\u007F]/g;
/** CSI sequences: ESC [ params intermediates final. Linear, no backtracking. */
const ANSI_CSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
/** Two-character ESC sequences and a bare ESC that starts neither. */
const ANSI_OTHER = /\x1b[@-_]?/g;
/** Leading runner timestamp, e.g. `2026-11-01T10:00:00.1234567Z `. */
const LEADING_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z /;

const MARKERS: ReadonlyArray<{ prefix: string; tone: LogLine['tone'] }> = [
  { prefix: '##[error]', tone: 'error' },
  { prefix: '##[warning]', tone: 'warning' },
  { prefix: '##[group]', tone: 'group' },
  { prefix: '##[command]', tone: 'command' },
];

function classify(line: string): LogLine {
  if (line.startsWith('##[endgroup]')) return { text: '', tone: 'normal' };
  for (const marker of MARKERS) {
    if (line.startsWith(marker.prefix)) {
      return { text: line.slice(marker.prefix.length), tone: marker.tone };
    }
  }
  if (line.startsWith('[command]')) return { text: line.slice('[command]'.length), tone: 'command' };
  return { text: line, tone: 'normal' };
}

/**
 * Full pipeline, in the documented order. Never throws on hostile input.
 */
export function processLog(
  input: { bytes: Uint8Array; headDropped: boolean },
  limits: Partial<LogLimits> = {},
  maskedText: string = DEFAULT_MASKED_TEXT,
): { state: Exclude<LogState, 'expired' | 'tooLarge' | 'blocked'>; lines: LogLine[]; headCut: boolean } {
  const l: LogLimits = { ...DEFAULT_LOG_LIMITS, ...limits };
  let cut = input.headDropped;

  // 1. Binary check over the head of the window.
  const probe = input.bytes.subarray(0, 4096);
  if (probe.includes(0)) return { state: 'binary', lines: [], headCut: false };

  // 2. Decode, drop a leading BOM.
  let text = new TextDecoder('utf-8', { fatal: false }).decode(input.bytes);
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  // 3. Split, keep the last segment of a progress line, drop a partial head line.
  let raw = text.split('\n').map((line) => {
    const cr = line.lastIndexOf('\r');
    return cr === -1 ? line : line.slice(cr + 1);
  });
  if (input.headDropped && raw.length > 0) raw = raw.slice(1);

  // 4-5. Strip escapes and the leading timestamp.
  const cleaned = raw.map((line) =>
    line.replace(ANSI_CSI, '').replace(ANSI_OTHER, '').replace(C0_EXCEPT_TAB, '').replace(LEADING_TIMESTAMP, ''),
  );

  // 6. Mask PEM blocks before anything is cut.
  const masked: string[] = [];
  let inPem = false;
  for (const line of cleaned) {
    if (!inPem && line.includes('-----BEGIN ') && line.includes('PRIVATE KEY')) {
      inPem = true;
      masked.push(maskedText);
      continue;
    }
    if (inPem) {
      // A blank line inside the block stays blank: masking it would leave a
      // fake masked line after the trailing-empty trim.
      masked.push(line.trim() === '' ? '' : maskedText);
      if (line.includes('-----END ')) inPem = false;
      continue;
    }
    masked.push(line);
  }

  // 7. Drop group-end markers and classify the rest.
  let classified: LogLine[] = [];
  for (const line of masked) {
    if (line.startsWith('##[endgroup]')) continue;
    classified.push(classify(line));
  }

  // 8. Drop trailing empty lines, keep the last `maxLines`.
  while (classified.length > 0 && classified[classified.length - 1]?.text.trim() === '') {
    classified.pop();
  }
  if (classified.length > l.maxLines) {
    classified = classified.slice(classified.length - l.maxLines);
    cut = true;
  }

  // 9. Per-line cap, then redact (redaction runs after the cap to bound cost).
  const capped = classified.map((line) => {
    const text = line.text.length > l.maxLineChars
      ? `${line.text.slice(0, l.maxLineChars - 3)}...`
      : line.text;
    return { text: redact(text), tone: line.tone };
  });

  // 10. Total character cap, dropping the oldest lines.
  let total = 0;
  let first = capped.length;
  while (first > 0) {
    const cost = (capped[first - 1]?.text.length ?? 0) + 1;
    if (total + cost > l.maxChars) {
      cut = true;
      break;
    }
    total += cost;
    first -= 1;
  }
  const lines = capped.slice(first);

  // 11. Nothing left.
  if (lines.length === 0) return { state: 'empty', lines: [], headCut: cut };
  return { state: 'ok', lines, headCut: cut };
}

/** Default storage suffixes, only meaningful when the API base is GitHub's own. */
const GITHUB_LOG_SUFFIXES = ['.github.com', '.githubusercontent.com', '.blob.core.windows.net'];

/** IPv4 literal, any IPv6 form, and the names that only ever mean "this machine". */
const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;
const LOCAL_SUFFIXES = ['.local', '.internal', '.localhost'];

/**
 * Whether a host may serve a log for this API base.
 *
 * Fails closed: an unknown host is refused and the UI offers `Open full log`.
 * The enterprise list is derived from the configured base, never from the
 * redirect itself.
 */
export function isLogHostAllowed(hostname: string, apiHostname: string): boolean {
  const host = hostname.toLowerCase();
  const apiHost = apiHostname.toLowerCase();
  if (host === apiHost || host.endsWith(`.${apiHost}`)) return true;
  if (apiHost === 'github.com' || apiHost.endsWith('.github.com')) {
    return GITHUB_LOG_SUFFIXES.some((suffix) => host === suffix.slice(1) || host.endsWith(suffix));
  }
  return false;
}

/**
 * Validate the `Location` of hop 1. Returns `null` on anything the policy does
 * not trust; the caller never contacts a host that failed here.
 */
export function validateLogLocation(location: string, apiUrl: string): URL | null {
  if (typeof location !== 'string' || location.length === 0 || location.length > 4096) return null;
  // A backslash is a path separator to the WHATWG parser and an ordinary
  // character to others. Refuse the ambiguity rather than guess.
  if (location.includes('\\')) return null;

  let url: URL;
  let apiHost: string;
  try {
    url = new URL(location, apiUrl);
    apiHost = new URL(apiUrl).hostname;
  } catch {
    return null;
  }

  if (url.protocol !== 'https:') return null;
  if (url.username !== '' || url.password !== '') return null;
  if (url.port !== '' && url.port !== '443') return null;

  const host = url.hostname.toLowerCase();
  if (host === '' || host.includes(':')) return null;
  if (IPV4.test(host)) return null;
  if (host === 'localhost') return null;
  if (LOCAL_SUFFIXES.some((suffix) => host.endsWith(suffix))) return null;

  return isLogHostAllowed(host, apiHost) ? url : null;
}
