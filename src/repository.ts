/**
 * Per-repository read model.
 *
 * Owns one {@link GitRunner} plus the caches the UI reads from. All git access
 * goes through the runner; this module never spawns a process itself.
 *
 * `vscode` is not imported: persistence arrives as a {@link PersistentStore}
 * (backed by `workspaceState` in production) so the service stays testable.
 */
import { createHash } from 'node:crypto';
import { GitRunner } from './git';
import { layoutGraph, type LayoutRef } from './layout';
import type {
  ChangeEntry,
  CommitDetail,
  CommitFileChange,
  ConflictEntry,
  GraphNode,
  Lang,
  RefInfo,
  RepoGraph,
  RepoStatus,
} from './messages';
import type { ParsedCommit, ParsedNumstatEntry, ParsedRef, ParsedStatusEntry } from './gitParse';

/** Narrow slice of `vscode.Memento` that this service needs. */
export interface PersistentStore {
  get<T>(key: string, defaultValue: T): T;
  update(key: string, value: unknown): Thenable<void> | Promise<void>;
}

export interface RepositoryOptions {
  /** Filesystem path of the workspace folder (from `folder.uri.fsPath`). */
  folderPath: string;
  gitPath: string;
  store: PersistentStore;
  logger?: (line: string) => void;
  /** Hard ceiling on commits loaded into the graph. */
  commitLimit?: number;
  /** Commits fetched per page. */
  pageSize?: number;
  /** Cap on the file list of a single commit detail. */
  fileLimit?: number;
}

export interface GraphRequest {
  limit?: number;
  /** Number of commits to skip; `undefined` starts at the newest commit. */
  cursor?: number;
  laneHeight?: number;
  columnWidth?: number;
  rowHeight?: number;
  laneWidth?: number;
  lang?: Lang;
}

export const MAX_COMMIT_LIMIT = 10_000;
export const DEFAULT_PAGE_SIZE = 500;
export const DEFAULT_FILE_LIMIT = 2000;
/**
 * Above this many changed files, `status` stops asking git for line counts. Past
 * that point the panel is a bulk view where per-file churn is not read, and two
 * `git diff --numstat` runs over a huge worktree would dominate every refresh.
 */
export const MAX_STAT_ENTRIES = 2000;
const LAST_FETCH_KEY_PREFIX = 'gitControl.lastFetchAt:';

export class RepositoryService {
  readonly folderPath: string;
  readonly git: GitRunner;

  private readonly store: PersistentStore;
  private readonly commitLimit: number;
  private readonly pageSize: number;
  private readonly fileLimit: number;

  private statusCache: RepoStatus | undefined;
  /** Last graph that loaded successfully, replayed as `stale` after a failure. */
  private graphCache: RepoGraph | undefined;
  private readonly detailCache = new Map<string, CommitDetail>();
  private repoRootCache: string | undefined;

  constructor(options: RepositoryOptions) {
    this.folderPath = options.folderPath;
    this.store = options.store;
    this.commitLimit = clamp(options.commitLimit ?? MAX_COMMIT_LIMIT, 1, MAX_COMMIT_LIMIT);
    this.pageSize = clamp(options.pageSize ?? DEFAULT_PAGE_SIZE, 1, this.commitLimit);
    this.fileLimit = clamp(options.fileLimit ?? DEFAULT_FILE_LIMIT, 1, 100_000);
    this.git = new GitRunner({
      gitPath: options.gitPath,
      cwd: options.folderPath,
      ...(options.logger === undefined ? {} : { logger: options.logger }),
    });
  }

  async isRepository(): Promise<boolean> {
    return this.git.isRepository();
  }

  async repoRoot(): Promise<string> {
    if (this.repoRootCache === undefined) this.repoRootCache = await this.git.repoRoot();
    return this.repoRootCache;
  }

  /** Drop every cached read. Call after any mutation or watcher event. */
  invalidate(): void {
    this.statusCache = undefined;
    this.detailCache.clear();
    // graphCache is deliberately kept: it is the offline fallback (PRD §9).
  }

  /** Cached status, or a fresh read when the cache was invalidated. */
  async status(opts: { includeIgnored?: boolean } = {}): Promise<RepoStatus> {
    if (this.statusCache !== undefined) return this.statusCache;
    const status = await this.readStatus(opts.includeIgnored === true);
    this.statusCache = status;
    return status;
  }

  /** Working-tree changes plus the derived conflict list. */
  async changes(
    opts: { includeIgnored?: boolean } = {},
  ): Promise<{ changes: ChangeEntry[]; conflicts: ConflictEntry[] }> {
    const entries = await this.git.status({ includeIgnored: opts.includeIgnored === true });
    // No line counts here: this path is the conflict list, and `status()` is what
    // the panel reads for churn.
    return {
      changes: entries.map((entry) => toChangeEntry(entry, undefined)),
      conflicts: toConflicts(entries),
    };
  }

  /**
   * One page of the commit graph, laid out for rendering.
   *
   * When git fails and a previous graph is cached, that snapshot is returned
   * with `stale: true` instead of an error so the UI stays usable offline.
   */
  async graph(request: GraphRequest = {}): Promise<RepoGraph> {
    const cursor = Math.max(0, request.cursor ?? 0);
    const requested = request.limit ?? this.pageSize;
    // Never load past the configured ceiling, even across pages.
    const remaining = Math.max(0, this.commitLimit - cursor);
    const limit = Math.min(clamp(requested, 1, this.commitLimit), remaining);

    try {
      if (limit === 0) {
        const empty = await this.emptyGraph();
        return empty;
      }
      const [commits, refs, current] = await Promise.all([
        this.git.log({ all: true, limit, skip: cursor }),
        this.git.refs(),
        this.git.currentBranch(),
      ]);

      const layout = layoutGraph(
        {
          commits: commits.map((c) => ({
            hash: c.hash,
            parents: c.parents,
            committedAt: c.committedAt,
          })),
          refs: refs.map(toLayoutRef),
          head: current.head,
          currentBranch: current.branch,
        },
        {
          ...(request.laneHeight !== undefined
            ? { laneHeight: request.laneHeight }
            : request.rowHeight !== undefined
              ? { laneHeight: request.rowHeight }
              : {}),
          ...(request.columnWidth !== undefined
            ? { columnWidth: request.columnWidth }
            : request.laneWidth !== undefined
              ? { columnWidth: request.laneWidth }
              : {}),
          ...(request.lang !== undefined ? { lang: request.lang } : {}),
        },
      );

      const byHash = new Map(commits.map((c) => [c.hash, c]));
      const nodes: GraphNode[] = layout.nodes.map((node) => {
        const commit = byHash.get(node.hash) as ParsedCommit;
        return {
          hash: node.hash,
          shortHash: commit.shortHash,
          x: node.x,
          y: node.y,
          lane: node.lane,
          isHead: node.isHead,
          isMerge: node.isMerge,
          local: node.local,
          subject: commit.subject,
          authorName: commit.authorName,
          authoredAt: commit.authoredAt,
          refNames: commit.refNames,
        };
      });

      // A full page implies more history may exist; the cap implies truncation.
      const consumed = cursor + commits.length;
      const pageFull = commits.length === limit;
      const atCap = consumed >= this.commitLimit;
      const graph: RepoGraph = {
        nodes,
        edges: layout.edges,
        lanes: layout.lanes,
        dateBuckets: layout.dateBuckets,
        refs: refs.map(toRefInfo),
        head: current.head,
        truncated: atCap && pageFull,
        nextCursor: pageFull && !atCap ? consumed : null,
        stale: false,
      };
      this.graphCache = graph;
      return graph;
    } catch (err) {
      if (this.graphCache !== undefined) return { ...this.graphCache, stale: true };
      throw err;
    }
  }

  /**
   * Metadata plus per-file stats for one commit. Merge commits list every
   * parent so the UI can offer a parent selector; the diff itself is taken
   * against the first parent.
   *
   * `fileCursor` pages the file list: a commit touching more files than
   * `fileLimit` is served one page at a time, and `nextFileCursor` carries the
   * offset of the following page (`null` once the list is exhausted). `totals`
   * always describes the whole commit, not the current page.
   */
  async commitDetail(hash: string, opts: { fileCursor?: number } = {}): Promise<CommitDetail | null> {
    const cursor = normalizeCursor(opts.fileCursor);
    const cacheKey = `${hash}:${cursor}`;
    const cached = this.detailCache.get(cacheKey);
    if (cached !== undefined) return cached;

    const meta = await this.git.commitMeta(hash);
    if (meta === null) return null;
    const isMerge = meta.parents.length > 1;
    // A commit touching hundreds of thousands of files produces a `--numstat`
    // larger than the runner will buffer. It truncates rather than failing, and
    // the flag rides out with the page so the UI does not claim completeness.
    let statsTruncated = false;
    const stats = await this.git.numstat(meta.hash, {
      firstParent: isMerge,
      onTruncated: () => {
        statsTruncated = true;
      },
    });

    const end = cursor + this.fileLimit;
    const hasMorePages = stats.length > end;
    // `truncated` means "there is more than you are seeing", which is true both
    // when a later page exists and when git's own output was cut short.
    const truncated = hasMorePages || statsTruncated;
    const files: CommitFileChange[] = stats.slice(cursor, end).map((entry) => ({
      path: entry.path,
      ...(entry.origPath === undefined ? {} : { origPath: entry.origPath }),
      // Binary files carry no line counts.
      additions: entry.binary ? null : entry.additions,
      deletions: entry.binary ? null : entry.deletions,
      binary: entry.binary,
    }));

    const detail: CommitDetail = {
      hash: meta.hash,
      shortHash: meta.shortHash,
      parents: meta.parents,
      authorName: meta.authorName,
      authorEmail: meta.authorEmail,
      authoredAt: meta.authoredAt,
      committerName: meta.committerName,
      committedAt: meta.committedAt,
      subject: meta.subject,
      body: meta.body,
      refNames: meta.refNames,
      files,
      totals: totalsOf(stats),
      truncated,
      fileCursor: cursor,
      // Only offer a next page when one actually exists. A `--numstat` cut off by
      // the byte cap has no further page to serve.
      nextFileCursor: hasMorePages ? end : null,
    };
    this.detailCache.set(cacheKey, detail);
    return detail;
  }

  // ------------------------------------------------------------ fetch clock

  /** Epoch ms of the last successful fetch, surviving reloads. */
  lastFetchAt(): number | null {
    const value = this.store.get<number | null>(this.lastFetchKey(), null);
    return typeof value === 'number' ? value : null;
  }

  /** Record a successful fetch. Called by the bridge, not by `graph`/`status`. */
  async markFetched(at: number = Date.now()): Promise<void> {
    await this.store.update(this.lastFetchKey(), at);
    this.invalidate();
  }

  private lastFetchKey(): string {
    return `${LAST_FETCH_KEY_PREFIX}${this.folderPath}`;
  }

  // ---------------------------------------------------------------- private

  private async emptyGraph(): Promise<RepoGraph> {
    const [refs, current] = await Promise.all([this.git.refs(), this.git.currentBranch()]);
    return {
      nodes: [],
      edges: [],
      lanes: [],
      dateBuckets: [],
      refs: refs.map(toRefInfo),
      head: current.head,
      truncated: true,
      nextCursor: null,
      stale: false,
    };
  }

  private async readStatus(includeIgnored: boolean): Promise<RepoStatus> {
    const [repoRoot, current, entries, operation] = await Promise.all([
      this.repoRoot(),
      this.git.currentBranch(),
      this.git.status({ includeIgnored }),
      this.git.operationState(),
    ]);

    /*
     * Line counts cost two extra `git diff` runs, and `repos/status` is the most
     * frequently called request in the extension: the webview refreshes it on every
     * repository event AND before every mutation, to prove the status token is
     * fresh. So the counts are bought only when they can be shown and only while
     * they stay cheap — a clean tree needs no diff at all, and a worktree with more
     * than MAX_STAT_ENTRIES changed files is a bulk operation where the numbers are
     * noise anyway. When skipped the counts stay `null`, which the UI renders as
     * "not computed" rather than as zero.
     *
     * Both runs are started before the upstream lookups below so they overlap with
     * them instead of adding their own round trip. A failure degrades to no counts:
     * churn is decoration, and it must never be able to fail a status read.
     *
     * A degraded read is REPORTED, not hidden. Skipping past MAX_STAT_ENTRIES and a
     * `--numstat` cut off by its byte cap both leave rows without numbers, and a
     * reader who is not told assumes those files did not change. A failed diff
     * counts too: it also produces a change list with counts missing. An empty
     * worktree is the one case that is not incomplete — there was nothing to count.
     */
    const wantStats = entries.length > 0 && entries.length <= MAX_STAT_ENTRIES;
    const statsPromise: Promise<{
      worktree: ParsedNumstatEntry[];
      index: ParsedNumstatEntry[];
      truncated: boolean;
    }> = wantStats
      ? Promise.all([this.git.diffNumstat({}), this.git.diffNumstat({ cached: true })])
          .then(([worktree, index]) => ({
            worktree: worktree.entries,
            index: index.entries,
            truncated: worktree.truncated || index.truncated,
          }))
          .catch(() => ({ worktree: [], index: [], truncated: true }))
      : Promise.resolve({ worktree: [], index: [], truncated: entries.length > 0 });

    const upstream = current.branch === null ? null : await this.git.upstreamOf(current.branch);
    const counts = upstream === null ? { ahead: 0, behind: 0 } : await this.git.aheadBehind();
    const { worktree: worktreeStat, index: indexStat, truncated: churnTruncated } =
      await statsPromise;

    const stats = mergeNumstat(worktreeStat, indexStat);
    const changes = entries.map((entry) => toChangeEntry(entry, stats.get(entry.path)));
    const conflicts = toConflicts(entries);
    const dirty = entries.some((e) => e.unstaged || e.untracked || e.conflicted);
    const staged = entries.some((e) => e.staged);
    const lastFetchAt = this.lastFetchAt();

    return {
      repoRoot,
      branch: current.branch,
      head: current.head,
      detached: current.branch === null && current.head !== null,
      upstream,
      ahead: counts.ahead,
      behind: counts.behind,
      incoming: counts.behind,
      outgoing: counts.ahead,
      dirty,
      staged,
      operation,
      changes,
      conflicts,
      churnTruncated,
      statusToken: statusToken({
        head: current.head,
        branch: current.branch,
        operation,
        entries,
      }),
      lastFetchedAt: lastFetchAt === null ? null : new Date(lastFetchAt).toISOString(),
      lastFetchAt,
    };
  }
}

/**
 * Fingerprint of everything an action could be built on. A mutation whose
 * `statusToken` no longer matches was computed against stale state.
 */
function statusToken(input: {
  head: string | null;
  branch: string | null;
  operation: string;
  entries: readonly ParsedStatusEntry[];
}): string {
  const hash = createHash('sha256');
  hash.update(input.head ?? 'none');
  hash.update('\u0000');
  hash.update(input.branch ?? 'detached');
  hash.update('\u0000');
  hash.update(input.operation);
  for (const entry of input.entries) {
    hash.update('\u0000');
    hash.update(`${entry.indexStatus}${entry.worktreeStatus}${entry.path}`);
  }
  return hash.digest('hex').slice(0, 16);
}

function toChangeEntry(entry: ParsedStatusEntry, stat: ParsedNumstatEntry | undefined): ChangeEntry {
  return {
    path: entry.path,
    ...(entry.origPath === undefined ? {} : { origPath: entry.origPath }),
    indexStatus: entry.indexStatus,
    worktreeStatus: entry.worktreeStatus,
    staged: entry.staged,
    unstaged: entry.unstaged,
    untracked: entry.untracked,
    // `null` means "not counted", not "zero": an untracked file is in no diff at
    // all, and a binary file has no line counts to report.
    additions: stat === undefined || stat.binary ? null : stat.additions,
    deletions: stat === undefined || stat.binary ? null : stat.deletions,
    binary: stat?.binary ?? false,
  };
}

/**
 * One churn record per path, summing the index and the working tree.
 *
 * A file can be half staged: `git diff` reports the unstaged hunks and
 * `git diff --cached` the staged ones, and the panel shows one row for the file, so
 * the row must show the total change against HEAD. Binary wins over counts, because
 * a file that is binary on either side has no meaningful sum.
 */
function mergeNumstat(
  worktree: readonly ParsedNumstatEntry[],
  index: readonly ParsedNumstatEntry[],
): Map<string, ParsedNumstatEntry> {
  const merged = new Map<string, ParsedNumstatEntry>();
  for (const stat of [...worktree, ...index]) {
    const previous = merged.get(stat.path);
    if (previous === undefined) {
      merged.set(stat.path, stat);
      continue;
    }
    const binary = previous.binary || stat.binary;
    merged.set(stat.path, {
      path: stat.path,
      ...(stat.origPath === undefined
        ? previous.origPath === undefined
          ? {}
          : { origPath: previous.origPath }
        : { origPath: stat.origPath }),
      additions: binary ? null : (previous.additions ?? 0) + (stat.additions ?? 0),
      deletions: binary ? null : (previous.deletions ?? 0) + (stat.deletions ?? 0),
      binary,
    });
  }
  return merged;
}

function toConflicts(entries: readonly ParsedStatusEntry[]): ConflictEntry[] {
  return entries
    .filter((e) => e.conflicted)
    .map((e) => ({ path: e.path, code: `${e.indexStatus}${e.worktreeStatus}` }));
}

function toLayoutRef(ref: ParsedRef): LayoutRef {
  return { refName: ref.refName, objectName: ref.objectName };
}

function toRefInfo(ref: ParsedRef): RefInfo {
  const counts = parseTrack(ref.track);
  return {
    refName: ref.refName,
    shortName: shortRefName(ref.refName),
    kind: refKind(ref.refName),
    objectName: ref.objectName,
    upstream: ref.upstream,
    ahead: counts.ahead,
    behind: counts.behind,
    isHead: ref.isHead,
  };
}

function refKind(refName: string): RefInfo['kind'] {
  if (refName.startsWith('refs/remotes/')) return 'remote';
  if (refName.startsWith('refs/tags/')) return 'tag';
  return 'local';
}

function shortRefName(refName: string): string {
  for (const prefix of ['refs/heads/', 'refs/remotes/', 'refs/tags/']) {
    if (refName.startsWith(prefix)) return refName.slice(prefix.length);
  }
  return refName;
}

/** Parse `%(upstream:track)`, e.g. `[ahead 2, behind 1]`. */
function parseTrack(track: string): { ahead: number; behind: number } {
  const ahead = /ahead (\d+)/.exec(track);
  const behind = /behind (\d+)/.exec(track);
  return {
    ahead: ahead === null ? 0 : Number.parseInt(ahead[1] as string, 10),
    behind: behind === null ? 0 : Number.parseInt(behind[1] as string, 10),
  };
}

function totalsOf(
  stats: ReadonlyArray<{ additions: number | null; deletions: number | null; binary: boolean }>,
): CommitDetail['totals'] {
  let additions = 0;
  let deletions = 0;
  let binary = 0;
  for (const entry of stats) {
    if (entry.binary) {
      binary += 1;
      continue;
    }
    additions += entry.additions ?? 0;
    deletions += entry.deletions ?? 0;
  }
  return { files: stats.length, additions, deletions, binary };
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

/** A file cursor is a non-negative integer; anything else starts at the top. */
function normalizeCursor(value: number | undefined): number {
  if (value === undefined) return 0;
  if (!Number.isFinite(value) || value < 0) return 0;
  return Math.trunc(value);
}
