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
  /** Fixed ring of `tailBytes`. Appending never reallocates or shifts. */
  private readonly ring: Uint8Array;
  /** Ring index of the oldest retained byte. */
  private head = 0;
  /** Bytes currently retained, at most `tailBytes`. */
  private length = 0;
  private seen = 0;
  private dropped = false;
  /**
   * Whether a PEM private key block is open, tracked over EVERY byte pushed, not
   * only the retained window.
   *
   * This is the whole point of the class: a key block whose `-----BEGIN` line was
   * dropped by the window must still mask its body. Deriving the state from the
   * window alone would leak exactly that body. Markers can straddle a chunk
   * boundary, so the last few bytes are carried over and re-scanned.
   */
  private openSince: number | null = null;
  private carry = '';

  constructor(limits: Pick<LogLimits, 'tailBytes' | 'hardCapBytes'>) {
    this.tailBytes = Math.max(1, limits.tailBytes);
    this.hardCapBytes = limits.hardCapBytes;
    this.ring = new Uint8Array(this.tailBytes);
  }

  push(chunk: Uint8Array): 'ok' | 'overflow' {
    if (chunk.length === 0) return 'ok';
    this.seen += chunk.length;

    this.scan(chunk);
    this.write(chunk);
    return this.seen > this.hardCapBytes ? 'overflow' : 'ok';
  }

  /** Copy into the ring, wrapping and overwriting the oldest bytes as needed. */
  private write(chunk: Uint8Array): void {
    if (chunk.length >= this.tailBytes) {
      // The chunk alone fills the window: only its tail survives.
      this.dropped = true;
      this.ring.set(chunk.subarray(chunk.length - this.tailBytes));
      this.head = 0;
      this.length = this.tailBytes;
      return;
    }
    const overflow = this.length + chunk.length - this.tailBytes;
    if (overflow > 0) {
      this.dropped = true;
      this.head = (this.head + overflow) % this.tailBytes;
      this.length -= overflow;
    }
    const tail = (this.head + this.length) % this.tailBytes;
    const firstPart = Math.min(chunk.length, this.tailBytes - tail);
    this.ring.set(chunk.subarray(0, firstPart), tail);
    if (firstPart < chunk.length) {
      this.ring.set(chunk.subarray(firstPart), 0);
    }
    this.length += chunk.length;
  }

  /** Update the PEM state from the raw byte stream, independent of the window. */
  private scan(chunk: Uint8Array): void {
    // Latin1 is byte-for-byte and cannot throw on a partial UTF-8 sequence; the
    // markers are ASCII, so that is all this pass needs.
    const text = this.carry + latin1(chunk);
    let index = 0;
    for (;;) {
      const begin = text.indexOf('-----BEGIN ', index);
      const end = text.indexOf('-----END ', index);
      const next = begin === -1 ? end : end === -1 ? begin : Math.min(begin, end);
      if (next === -1) break;
      if (next === begin) {
        const lineEnd = text.indexOf('\n', begin);
        const head = lineEnd === -1 ? text.slice(begin) : text.slice(begin, lineEnd);
        // Stream offset of this BEGIN, so the answer can be re-based on the
        // window start later instead of on the end of the stream.
        if (head.includes('PRIVATE KEY') && this.openSince === null) {
          this.openSince = this.seen - chunk.length + this.carry.length + begin;
        }
        index = begin + 11;
      } else {
        this.openSince = null;
        index = end + 9;
      }
    }
    this.carry = text.slice(Math.max(0, text.length - 16));
  }

  get total(): number {
    return this.seen;
  }

  get headDropped(): boolean {
    return this.dropped;
  }

  /**
   * True when the retained window STARTS inside a PEM private key block.
   *
   * The question is about the window boundary, not the stream end: a block whose
   * BEGIN was dropped must still mask its body, while a block that begins inside
   * the window is found by `processLog` itself. `openSince` is the stream offset
   * of the opening BEGIN, so comparing it with the window start answers both.
   */
  get pemOpen(): boolean {
    if (this.openSince === null) return false;
    return this.openSince < this.seen - this.length;
  }

  /** The retained bytes, oldest first. One allocation, called once per download. */
  bytes(): Uint8Array {
    const out = new Uint8Array(this.length);
    const firstPart = Math.min(this.length, this.tailBytes - this.head);
    out.set(this.ring.subarray(this.head, this.head + firstPart), 0);
    if (firstPart < this.length) {
      out.set(this.ring.subarray(0, this.length - firstPart), firstPart);
    }
    return out;
  }
}

/** Byte-for-byte Latin1 decode. Cannot throw on a partial UTF-8 sequence. */
function latin1(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 1) out += String.fromCharCode(bytes[i] as number);
  return out;
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
  input: { bytes: Uint8Array; headDropped: boolean; pemOpen?: boolean },
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
  // The window may start inside a key block whose BEGIN was already dropped. The
  // caller knows that from `TailBuffer.pemOpen`, and ignoring it would render the
  // body in plaintext: exactly the case the masking step exists for.
  let inPem = input.pemOpen === true;
  if (inPem && cleaned.length > 0) {
    // The first retained line is partial or the block's first body line.
    masked.push(maskedText);
    if (cleaned[0]?.includes('-----END ')) inPem = false;
    cleaned.shift();
  }
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
