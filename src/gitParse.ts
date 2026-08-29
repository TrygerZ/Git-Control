/**
 * Pure parsers for git plumbing output. No process spawning, no vscode imports,
 * so every branch is unit-testable. All parsers tolerate CRLF line endings.
 */

/** Field separator inside a log record. */
export const LOG_FIELD_SEP = '\x1f';
/** Record separator between log records. */
export const LOG_RECORD_SEP = '\x1e';

/**
 * `git log` format string. Fields are NUL-adjacent control characters rather
 * than newlines so that multi-line commit bodies survive parsing intact.
 */
export const LOG_FORMAT =
  '--format=%x1f%H%x1f%h%x1f%P%x1f%an%x1f%ae%x1f%aI%x1f%cn%x1f%cI%x1f%D%x1f%s%x1f%b%x1e';

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
 * Parse output of `git log <LOG_FORMAT>`. Each record starts with the field
 * separator, so the first split element of a record is always empty.
 */
export function parseLog(raw: string): ParsedCommit[] {
  const commits: ParsedCommit[] = [];
  for (const rawRecord of raw.split(LOG_RECORD_SEP)) {
    // Leading newline belongs to the previous record's terminator.
    const record = rawRecord.replace(/^[\r\n]+/, '');
    if (record.length === 0) continue;
    const fields = record.split(LOG_FIELD_SEP);
    // fields[0] is the empty string before the first %x1f.
    if (fields.length < 12) continue;
    const [, hash, shortHash, parents, authorName, authorEmail, authoredAt, committerName, committedAt, refs, subject, ...bodyParts] =
      fields as [string, string, string, string, string, string, string, string, string, string, string, ...string[]];
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
      body: bodyParts.join(LOG_FIELD_SEP).replace(/[\r\n]+$/, ''),
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
 * Parse `git show --numstat` / `git diff --numstat` output. Binary files are
 * reported by git as `-\t-\tpath` and surface here with null counts. Renames
 * appear either as an `old => new` path or as a third+fourth tab column.
 */
export function parseShowStat(raw: string): ParsedNumstatEntry[] {
  const entries: ParsedNumstatEntry[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (line.length === 0) continue;
    const parts = line.split('\t');
    if (parts.length < 3) continue;
    const [added, removed, first, second] = parts as [string, string, string, ...string[]];
    if (!/^(\d+|-)$/.test(added) || !/^(\d+|-)$/.test(removed)) continue;
    const binary = added === '-' && removed === '-';
    const rename = resolveRename(first, second);
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

/** Resolve numstat rename notation into explicit old/new paths. */
function resolveRename(first: string, second: string | undefined): { path: string; origPath?: string } {
  if (second !== undefined && second.length > 0) {
    return { path: second, origPath: first };
  }
  const arrow = first.indexOf(' => ');
  if (arrow === -1) return { path: first };
  return { path: first.slice(arrow + 4), origPath: first.slice(0, arrow) };
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
    const fields = line.split(LOG_FIELD_SEP);
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

