/**
 * Pure parsers for git plumbing output. No process spawning, no vscode imports,
 * so every branch is unit-testable. All parsers tolerate CRLF line endings.
 */

/** Field separator inside a log record (NUL cannot appear in git commit objects). */
export const LOG_FIELD_SEP = '\0';
/** Record separator between log records when emitted with git log -z. */
export const LOG_RECORD_SEP = '\0';

/**
 * `git log` format string. Fields are NUL-delimited so that any commit message
 * (including control characters and multi-line bodies) survives parsing intact.
 */
export const LOG_FORMAT =
  '--format=%H%x00%h%x00%P%x00%an%x00%ae%x00%aI%x00%cn%x00%cI%x00%D%x00%s%x00%b';

export interface ParsedCommit {
  hash: string;
  shortHash: string;
  parents: string[];
  authorName: string;
  authorEmail: string;
  authoredAt: string;
  committerName: string;
  committedAt: string;
  refNames: string[];
  subject: string;
  body: string;
}

export type IndexStatus = string;

export interface ParsedStatusEntry {
  path: string;
  origPath?: string;
  indexStatus: IndexStatus;
  worktreeStatus: IndexStatus;
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
  conflicted: boolean;
}

export interface ParsedNumstatEntry {
  path: string;
  origPath?: string;
  additions: number | null;
  deletions: number | null;
  binary: boolean;
}

export interface AheadBehind {
  behind: number;
  ahead: number;
}

/** Porcelain v1 two-letter codes that mean an unresolved merge conflict. */
const CONFLICT_CODES = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']);

/**
 * Parse output of `git log -z <LOG_FORMAT>`. Each commit record consists of
 * exactly 11 NUL-delimited fields followed by the record-terminating NUL emitted
 * by `git log -z`.
 */
export function parseLog(raw: string): ParsedCommit[] {
  if (raw.length === 0) return [];
  // ponytail: 11-field NUL record framing assumes standard git log output order; upgrade to header length prefixing if git adds configurable custom record trailers.
  const tokens = raw.split('\0');
  const commits: ParsedCommit[] = [];
  for (let i = 0; i + 10 < tokens.length; i += 11) {
    const hash = tokens[i]?.trim() ?? '';
    if (hash.length === 0) continue;
    const shortHash = tokens[i + 1] ?? '';
    const parents = tokens[i + 2] ?? '';
    const authorName = tokens[i + 3] ?? '';
    const authorEmail = tokens[i + 4] ?? '';
    const authoredAt = tokens[i + 5] ?? '';
    const committerName = tokens[i + 6] ?? '';
    const committedAt = tokens[i + 7] ?? '';
    const refs = tokens[i + 8] ?? '';
    const subject = tokens[i + 9] ?? '';
    const body = tokens[i + 10] ?? '';
    commits.push({
      hash,
      shortHash,
      parents: parents.length > 0 ? parents.split(' ').filter((p) => p.length > 0) : [],
      authorName,
      authorEmail,
      authoredAt,
      committerName,
      committedAt,
      refNames: parseRefNames(refs),
      subject,
      body: body.replace(/[\r\n]+$/, ''),
    });
  }
  return commits;
}

/** Split a `%D` decoration list into individual ref names. */
function parseRefNames(decoration: string): string[] {
  if (decoration.trim().length === 0) return [];
  return decoration
    .split(',')
    .map((ref) => ref.trim())
    .filter((ref) => ref.length > 0)
    .map((ref) => (ref.startsWith('HEAD -> ') ? ref.slice('HEAD -> '.length) : ref));
}

/**
 * Parse `git status --porcelain=v1 -z --untracked-files=all`.
 * Records are NUL-terminated; rename/copy records are followed by a second
 * NUL-terminated field holding the original path.
 */
export function parseStatus(raw: string): ParsedStatusEntry[] {
  const tokens = raw.split('\0');
  const entries: ParsedStatusEntry[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === undefined || token.length < 4) continue;
    const indexStatus = token.charAt(0);
    const worktreeStatus = token.charAt(1);
    const path = token.slice(3);
    const code = `${indexStatus}${worktreeStatus}`;
    const conflicted = CONFLICT_CODES.has(code);
    const untracked = code === '??';
    let origPath: string | undefined;
    if (!conflicted && (indexStatus === 'R' || indexStatus === 'C')) {
      const next = tokens[i + 1];
      if (next !== undefined) {
        origPath = next;
        i += 1;
      }
    }
    entries.push({
      path,
      ...(origPath === undefined ? {} : { origPath }),
      indexStatus,
      worktreeStatus,
      staged: !conflicted && !untracked && indexStatus !== ' ' && indexStatus !== '?',
      unstaged: !conflicted && !untracked && worktreeStatus !== ' ' && worktreeStatus !== '?',
      untracked,
      conflicted,
    });
  }
  return entries;
}

/**
 * Decode git C-style quoted path (when core.quotePath emits "\t", "\"", octal escapes, etc.).
 * If the string is not enclosed in double quotes, returns it verbatim.
 */
export function unquoteGitPath(path: string): string {
  if (path.length < 2 || !path.startsWith('"') || !path.endsWith('"')) {
    return path;
  }
  const inner = path.slice(1, -1);
  const bytes: number[] = [];
  for (let i = 0; i < inner.length; i += 1) {
    const char = inner.charAt(i);
    if (char === '\\' && i + 1 < inner.length) {
      i += 1;
      const next = inner.charAt(i);
      if (next >= '0' && next <= '7') {
        let octal = next;
        while (i + 1 < inner.length && octal.length < 3) {
          const peek = inner.charAt(i + 1);
          if (peek >= '0' && peek <= '7') {
            i += 1;
            octal += peek;
          } else {
            break;
          }
        }
        bytes.push(Number.parseInt(octal, 8));
      } else {
        switch (next) {
          case 'a': bytes.push(0x07); break;
          case 'b': bytes.push(0x08); break;
          case 'f': bytes.push(0x0c); break;
          case 'n': bytes.push(0x0a); break;
          case 'r': bytes.push(0x0d); break;
          case 't': bytes.push(0x09); break;
          case 'v': bytes.push(0x0b); break;
          case '\\': bytes.push(0x5c); break;
          case '"': bytes.push(0x22); break;
          default:
            bytes.push(inner.charCodeAt(i));
            break;
        }
      }
    } else {
      const code = inner.charCodeAt(i);
      if (code < 128) {
        bytes.push(code);
      } else {
        const encoded = new TextEncoder().encode(char);
        for (const b of encoded) bytes.push(b);
      }
    }
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

/**
 * Parse `git show --numstat` / `git diff --numstat` output. Binary files are
 * reported by git as `-\t-\tpath` and surface here with null counts. Renames
 * appear as `{old => new}` or `old => new` on the path column.
 */
export function parseShowStat(raw: string): ParsedNumstatEntry[] {
  const entries: ParsedNumstatEntry[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (line.length === 0) continue;
    const firstTab = line.indexOf('\t');
    if (firstTab === -1) continue;
    const secondTab = line.indexOf('\t', firstTab + 1);
    if (secondTab === -1) continue;

    const added = line.slice(0, firstTab);
    const removed = line.slice(firstTab + 1, secondTab);
    const pathSpec = line.slice(secondTab + 1);

    if (!/^(\d+|-)$/.test(added) || !/^(\d+|-)$/.test(removed)) continue;
    const binary = added === '-' && removed === '-';
    const rename = resolveRename(pathSpec);
    entries.push({
      path: rename.path,
      ...(rename.origPath === undefined ? {} : { origPath: rename.origPath }),
      additions: binary ? null : Number.parseInt(added, 10),
      deletions: binary ? null : Number.parseInt(removed, 10),
      binary,
    });
  }
  return entries;
}

/**
 * Resolve numstat rename notation into explicit old/new paths.
 * Git numstat formats renames as `{old => new}` (with optional prefix/suffix)
 * or `old => new`, with individual paths optionally C-style quoted.
 */
function resolveRename(pathSpec: string): { path: string; origPath?: string } {
  // ponytail: handles standard {old => new} and old => new numstat renames with git C-style unquoting; full rename tracking with copy detection or multiple brace expansions requires -z plumbing.
  const braceMatch = /^(.*)\{(.*) => (.*)\}(.*)$/.exec(pathSpec);
  if (braceMatch) {
    const [, prefix = '', oldMiddle = '', newMiddle = '', suffix = ''] = braceMatch;
    return {
      path: unquoteGitPath(`${prefix}${newMiddle}${suffix}`),
      origPath: unquoteGitPath(`${prefix}${oldMiddle}${suffix}`),
    };
  }

  const arrowMatch = /^(.*) => (.*)$/.exec(pathSpec);
  if (arrowMatch) {
    const [, oldPath = '', newPath = ''] = arrowMatch;
    return {
      path: unquoteGitPath(newPath),
      origPath: unquoteGitPath(oldPath),
    };
  }

  return { path: unquoteGitPath(pathSpec) };
}


/**
 * Parse `git rev-list --left-right --count <upstream>...HEAD`, which prints
 * two tab-separated integers: left (behind) then right (ahead).
 */
export function parseRevListCounts(raw: string): AheadBehind {
  const match = /(\d+)\s+(\d+)/.exec(raw);
  if (match === null) return { behind: 0, ahead: 0 };
  return {
    behind: Number.parseInt(match[1] as string, 10),
    ahead: Number.parseInt(match[2] as string, 10),
  };
}

/**
 * Parse output of `git rev-list --parents -n 1 <hash>`.
 * The first token is the commit hash itself; following tokens are its parents.
 */
export function parseRevListParents(raw: string): string[] {
  const line = raw.trim().split(/[\r\n]+/)[0]?.trim();
  if (!line) return [];
  const tokens = line.split(/\s+/).filter((t) => t.length > 0);
  return tokens.slice(1);
}

/** Field order of {@link REFS_FORMAT}. */
export const REFS_FORMAT = '%(refname)%1f%(objectname)%1f%(upstream)%1f%(upstream:track)%1f%(HEAD)';

export interface ParsedRef {
  refName: string;
  objectName: string;
  upstream: string | null;
  track: string;
  isHead: boolean;
}

/** Parse `git for-each-ref --format=REFS_FORMAT`, one ref per line. */
export function parseRefs(raw: string): ParsedRef[] {
  const refs: ParsedRef[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (line.length === 0) continue;
    const fields = line.split('\x1f');
    if (fields.length < 5) continue;
    const [refName, objectName, upstream, track, head] = fields as [string, string, string, string, string];
    refs.push({
      refName,
      objectName,
      upstream: upstream.length > 0 ? upstream : null,
      track,
      isHead: head.trim() === '*',
    });
  }
  return refs;
}

/**
 * Parse `git remote -v` keeping the fetch and push URL of every remote.
 *
 * A remote configured with `pushurl` has two different URLs, and the UI needs
 * both: the fetch URL identifies the repository, the push URL is what a push
 * would actually contact.
 */
export function parseRemoteList(raw: string): Array<{ name: string; fetchUrl: string; pushUrl: string }> {
  const seen = new Map<string, { fetchUrl: string; pushUrl: string }>();
  for (const line of raw.split(/\r?\n/)) {
    if (line.length === 0) continue;
    const match = /^(\S+)\s+(\S+)\s+\((fetch|push)\)$/.exec(line.trim());
    if (match === null) continue;
    const [, name, url, kind] = match as unknown as [string, string, string, string];
    const entry = seen.get(name) ?? { fetchUrl: '', pushUrl: '' };
    if (kind === 'fetch') entry.fetchUrl = url;
    else entry.pushUrl = url;
    seen.set(name, entry);
  }
  // A remote listed only once uses that URL for both directions.
  return [...seen].map(([name, urls]) => ({
    name,
    fetchUrl: urls.fetchUrl.length > 0 ? urls.fetchUrl : urls.pushUrl,
    pushUrl: urls.pushUrl.length > 0 ? urls.pushUrl : urls.fetchUrl,
  }));
}

/** Parse `git remote -v` into unique remote names with their fetch URL. */
export function parseRemotes(raw: string): Array<{ name: string; url: string }> {
  const seen = new Map<string, string>();
  for (const line of raw.split(/\r?\n/)) {
    if (line.length === 0) continue;
    const match = /^(\S+)\s+(\S+)\s+\((fetch|push)\)$/.exec(line.trim());
    if (match === null) continue;
    const [, name, url, kind] = match as unknown as [string, string, string, string];
    if (kind === 'fetch' || !seen.has(name)) seen.set(name, url);
  }
  return [...seen].map(([name, url]) => ({ name, url }));
}

export interface ParsedContributor {
  name: string;
  email: string;
  count: number;
}

/**
 * Parse `git shortlog -sne HEAD` output.
 * Each line has the format: `<count>\t<name> <<email>>`.
 * Commit counts are sorted descending by git (`-n`).
 */
export function parseShortlog(raw: string): ParsedContributor[] {
  const entries: ParsedContributor[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (line.trim().length === 0) continue;
    const match = /^\s*(\d+)\t\s*(.*?)\s*<([^>]*)>\s*$/.exec(line);
    if (match === null) continue;
    const [, rawCount, rawName, rawEmail] = match as unknown as [string, string, string, string];
    const count = Number.parseInt(rawCount, 10);
    if (!Number.isFinite(count) || count < 1) continue;
    const name = rawName.trim();
    const email = rawEmail.trim();
    if (name.length === 0 && email.length === 0) continue;
    entries.push({ name, email, count });
  }
  return entries;
}

export interface ParsedStashEntry {
  ref: string;
  hash: string;
  subject: string;
}

/**
 * Parse `git stash list --format=%gd%x00%H%x00%gs` output.
 * Each entry is newline-separated with NUL delimiters separating ref, hash, and subject.
 */
export function parseStashList(raw: string): ParsedStashEntry[] {
  const entries: ParsedStashEntry[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (line.length === 0) continue;
    const parts = line.split('\0');
    if (parts.length < 3) continue;
    const [ref, hash, ...subjectParts] = parts;
    if (!ref || !hash) continue;
    entries.push({
      ref,
      hash,
      subject: subjectParts.join('\0'),
    });
  }
  return entries;
}



