/**
 * Repository change watcher.
 *
 * Two sources are needed: `vscode.workspace.createFileSystemWatcher` sees
 * working-tree edits, but the `.git` directory is often outside the workspace
 * glob (worktrees, submodules, `core.worktree`), so the git dir gets a plain
 * `fs.watch`.
 *
 * Bursts are coalesced behind a 500 ms debounce (PRD FEAT-01). While our own
 * exclusive git operation is in flight the timer is held: mutations touch
 * `index`, `HEAD` and `refs/**` many times, and emitting per write would thrash
 * the UI. One event fires after the operation settles.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { GitRunner } from './git';

export const DEBOUNCE_MS = 500;

/** Git-dir entries whose change means the repository moved. */
const GIT_DIR_WATCH_TARGETS = [
  'HEAD',
  'index',
  'MERGE_HEAD',
  'packed-refs',
  'refs',
] as const;

export interface RepoWatcherOptions {
  folder: vscode.WorkspaceFolder;
  git: GitRunner;
  onChange: () => void;
  onError?: (err: Error) => void;
  debounceMs?: number;
}

export class RepoWatcher implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly fsWatchers: fs.FSWatcher[] = [];
  private readonly onChange: () => void;
  private readonly onError: (err: Error) => void;
  private readonly debounceMs: number;
  private readonly git: GitRunner;
  private readonly folder: vscode.WorkspaceFolder;

  private timer: NodeJS.Timeout | undefined;
  private pendingChange = false;
  private busy = false;
  private disposed = false;

  constructor(options: RepoWatcherOptions) {
    this.folder = options.folder;
    this.git = options.git;
    this.onChange = options.onChange;
    this.onError = options.onError ?? ((): void => undefined);
    this.debounceMs = options.debounceMs ?? DEBOUNCE_MS;
  }

  /** Attach both watchers. Safe to await once; later calls are no-ops. */
  async start(): Promise<void> {
    if (this.disposed || this.disposables.length > 0) return;

    const pattern = new vscode.RelativePattern(this.folder, '**/*');
    const watcher = vscode.workspace.createFileSystemWatcher(pattern);
    this.disposables.push(
      watcher,
      watcher.onDidChange(() => this.schedule()),
      watcher.onDidCreate(() => this.schedule()),
      watcher.onDidDelete(() => this.schedule()),
      // Suppress while we mutate, then emit exactly once on completion.
      { dispose: this.git.onBusyChange((busy) => this.setBusy(busy)) },
    );

    await this.watchGitDir();
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
    for (const w of this.fsWatchers) w.close();
    this.fsWatchers.length = 0;
  }

  /** Force an immediate emit, bypassing the debounce (used by `refresh`). */
  flush(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.pendingChange = false;
    if (!this.disposed) this.onChange();
  }

  private setBusy(busy: boolean): void {
    this.busy = busy;
    // A mutation always changes the repository; emit once it settles.
    if (!busy) this.schedule();
    else if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
      this.pendingChange = true;
    }
  }

  private schedule(): void {
    if (this.disposed) return;
    this.pendingChange = true;
    if (this.busy) return;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (this.disposed || !this.pendingChange) return;
      this.pendingChange = false;
      this.onChange();
    }, this.debounceMs);
    // Never keep the host alive just for a pending refresh.
    this.timer.unref?.();
  }

  /**
   * Watch the resolved git dir. `refs` is watched recursively; the remaining
   * targets are files, so a single non-recursive watch on the git dir covers
   * them and avoids one handle per file.
   */
  private async watchGitDir(): Promise<void> {
    let gitDir: string;
    try {
      gitDir = await this.git.gitDir();
    } catch (err) {
      this.onError(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    if (this.disposed) return;

    const interesting = new Set<string>(GIT_DIR_WATCH_TARGETS);
    this.addFsWatch(gitDir, false, (filename) => {
      if (filename === null) return true;
      const head = filename.split(/[\\/]/)[0] ?? filename;
      return interesting.has(head);
    });
    this.addFsWatch(path.join(gitDir, 'refs'), true, () => true);
  }

  private addFsWatch(target: string, recursive: boolean, accept: (filename: string | null) => boolean): void {
    try {
      const watcher = fs.watch(target, { recursive, persistent: false }, (_event, filename) => {
        const name = typeof filename === 'string' ? filename : null;
        if (accept(name)) this.schedule();
      });
      watcher.on('error', (err) => this.onError(err instanceof Error ? err : new Error(String(err))));
      this.fsWatchers.push(watcher);
    } catch (err) {
      // A missing path (e.g. no `refs` yet) is not fatal; the workspace watcher
      // still covers working-tree edits.
      this.onError(err instanceof Error ? err : new Error(String(err)));
    }
  }
}
