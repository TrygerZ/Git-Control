/**
 * Extension host activation.
 *
 * Wires: git discovery → per-folder repository registry → watcher → message
 * bridge → webview panel + view. Everything created here is registered on the
 * context subscriptions so `deactivate` is a no-op beyond VS Code's own
 * disposal pass.
 */
import * as path from 'node:path';
import * as vscode from 'vscode';
import { MessageBridge, type BridgeHost, type WebviewLike } from './bridge';
import { GitRunner } from './git';
import {
  GITHUB_MESSAGES,
  GitHubClient,
  GitHubError,
  hasPrivateScope,
} from './github';
import { Logger } from './logger';
import { parseRemoteUrl, webUrlOf, type ParsedRemoteUrl } from './remoteUrl';
import { MAX_COMMIT_LIMIT, RepositoryService } from './repository';
import { RepoWatcher } from './watcher';
import type {
  GitHubAuthState,
  GitHubLinkage,
  GitHubRepoInfo,
  GitHubRepoPayload,
  OpenDiffPayload,
  OpenDiffResult,
  PullRequestsPayload,
  PullRequestsResult,
  SettingsSetPayload,
  SettingsSnapshot,
  UiPreferences,
} from './messages';

const MESSAGES = {
  gitMissing: 'Git tidak ditemukan pada PATH.',
  gitMissingAction: 'Petunjuk instalasi',
  notARepo: 'Folder ini bukan repository Git.',
  pickFolder: 'Pilih folder',
  pickRepo: 'Pilih repository',
  noFolder: 'Buka folder terlebih dahulu.',
  githubConnected: 'GitHub tersambung.',
  githubDisconnected: 'GitHub diputus.',
  githubPrompt: 'Tempel Personal Access Token GitHub',
  refreshed: 'Git Control dimuat ulang.',
  diffTrimmed: 'Diff dipangkas demi performa.',
  diffBinary: 'Diff teks tidak tersedia untuk file binary.',
} as const;

const GIT_INSTALL_URL = 'https://git-scm.com/downloads';
const TOKEN_SECRET_KEY = 'gitControl.githubToken';
const UI_PREFS_KEY = 'gitControl.uiPreferences';
const ACTIVE_REPO_KEY = 'gitControl.activeRepo';
/** Private scheme for historical blobs, served read-only from memory. */
const DIFF_SCHEME = 'git-control';
/** Above this size a historical blob is replaced by the PRD's summary message. */
const MAX_DIFF_BYTES = 5 * 1024 * 1024;
const DEFAULT_API_URL = 'https://api.github.com';

let controller: Controller | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const channel = vscode.window.createOutputChannel('Git Control');
  context.subscriptions.push(channel);
  const logger = new Logger(channel);

  controller = new Controller(context, logger, channel);
  context.subscriptions.push(controller);
  await controller.initialize();
}

export function deactivate(): void {
  controller?.dispose();
  controller = undefined;
}

/** Owns all host state for the session. */
class Controller implements vscode.Disposable {
  private readonly context: vscode.ExtensionContext;
  private readonly logger: Logger;
  private readonly channel: vscode.OutputChannel;
  private readonly repositories = new Map<string, RepositoryService>();
  private readonly watchers = new Map<string, RepoWatcher>();
  private readonly bridges = new Set<MessageBridge>();
  private readonly disposables: vscode.Disposable[] = [];
  private panel: vscode.WebviewPanel | undefined;
  private gitPath: string | null = null;
  private activeRepoPath: string | undefined;
  /** Cached GitHub client, rebuilt when the API base or the token changes. */
  private github: { client: GitHubClient; apiUrl: string; token: string | null } | undefined;

  constructor(context: vscode.ExtensionContext, logger: Logger, channel: vscode.OutputChannel) {
    this.context = context;
    this.logger = logger;
    this.channel = channel;
  }

  async initialize(): Promise<void> {
    this.registerCommands();
    this.registerViews();
    this.registerDiffProvider();

    this.disposables.push(
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        void this.rebuildRegistry();
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('gitControl.gitPath')) void this.rediscoverGit();
      }),
    );

    this.gitPath = await this.discoverGit();
    if (this.gitPath === null) {
      this.reportGitMissing();
      return;
    }
    await this.rebuildRegistry();
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
    for (const w of this.watchers.values()) w.dispose();
    this.watchers.clear();
    for (const b of this.bridges) b.dispose();
    this.bridges.clear();
    this.repositories.clear();
    this.panel?.dispose();
    this.panel = undefined;
  }

  // ------------------------------------------------------------- git lookup

  /** Resolve the git executable: setting first, then `git` on PATH. */
  private async discoverGit(): Promise<string | null> {
    const configured = vscode.workspace.getConfiguration('gitControl').get<string>('gitPath', '').trim();
    for (const candidate of configured.length > 0 ? [configured, 'git'] : ['git']) {
      const probe = new GitRunner({ gitPath: candidate, cwd: this.probeCwd() });
      try {
        const version = await probe.version();
        this.logger.info('git/discover', `${candidate} ${version}`);
        return candidate;
      } catch {
        // Try the next candidate.
      }
    }
    return null;
  }

  private probeCwd(): string {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
  }

  private reportGitMissing(): void {
    this.logger.info('git/missing', MESSAGES.gitMissing);
    void vscode.window
      .showErrorMessage(MESSAGES.gitMissing, MESSAGES.gitMissingAction)
      .then((choice) => {
        if (choice === MESSAGES.gitMissingAction) {
          void vscode.env.openExternal(vscode.Uri.parse(GIT_INSTALL_URL));
        }
      });
  }

  private async rediscoverGit(): Promise<void> {
    this.gitPath = await this.discoverGit();
    if (this.gitPath === null) {
      this.reportGitMissing();
      return;
    }
    await this.rebuildRegistry();
  }

  // -------------------------------------------------------------- registry

  /** Rebuild the per-folder repository map. Multi-root aware. */
  private async rebuildRegistry(): Promise<void> {
    if (this.gitPath === null) return;
    for (const w of this.watchers.values()) w.dispose();
    this.watchers.clear();
    this.repositories.clear();

    const folders = vscode.workspace.workspaceFolders ?? [];
    for (const folder of folders) {
      const service = new RepositoryService({
        folderPath: folder.uri.fsPath,
        gitPath: this.gitPath,
        store: this.context.workspaceState,
        logger: (line) => this.logger.info('git/exec', line),
        ...this.limits(),
      });
      if (!(await service.isRepository())) continue;
      this.repositories.set(folder.uri.fsPath, service);

      const watcher = new RepoWatcher({
        folder,
        git: service.git,
        onChange: () => {
          service.invalidate();
          void this.broadcastRepoChanged('fs');
        },
        onError: (err) => this.logger.info('watcher/error', err.message),
      });
      await watcher.start();
      this.watchers.set(folder.uri.fsPath, watcher);
    }

    if (this.activeRepoPath !== undefined && !this.repositories.has(this.activeRepoPath)) {
      this.activeRepoPath = undefined;
    }
    if (this.activeRepoPath === undefined) {
      const remembered = this.context.workspaceState.get<string>(ACTIVE_REPO_KEY, '');
      if (this.repositories.has(remembered)) this.activeRepoPath = remembered;
    }

    this.logger.info('registry/build', `${this.repositories.size} repository`);
    if (folders.length > 0 && this.repositories.size === 0) this.reportNotARepository();
  }

  private limits(): { commitLimit: number; pageSize: number } {
    const config = vscode.workspace.getConfiguration('gitControl');
    return {
      commitLimit: Math.min(config.get<number>('commitLimit', MAX_COMMIT_LIMIT), MAX_COMMIT_LIMIT),
      pageSize: config.get<number>('pageSize', 500),
    };
  }

  private reportNotARepository(): void {
    void vscode.window.showWarningMessage(MESSAGES.notARepo, MESSAGES.pickFolder).then((choice) => {
      if (choice === MESSAGES.pickFolder) {
        void vscode.commands.executeCommand('vscode.openFolder');
      }
    });
  }

  /** Active repository: explicit pick, else the only one, else the first. */
  private async resolveRepository(): Promise<RepositoryService | null> {
    if (this.repositories.size === 0) return null;
    if (this.activeRepoPath !== undefined) {
      const active = this.repositories.get(this.activeRepoPath);
      if (active !== undefined) return active;
    }
    const editor = vscode.window.activeTextEditor;
    if (editor !== undefined) {
      const folder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
      const match = folder === undefined ? undefined : this.repositories.get(folder.uri.fsPath);
      if (match !== undefined) return match;
    }
    return this.repositories.values().next().value ?? null;
  }

  /** Repo picker, shown only when several repositories exist. */
  private async pickRepository(): Promise<void> {
    if (this.repositories.size < 2) return;
    const picked = await vscode.window.showQuickPick(
      [...this.repositories.keys()].map((p) => ({ label: vscode.Uri.file(p).path.split('/').pop() ?? p, description: p })),
      { placeHolder: MESSAGES.pickRepo },
    );
    if (picked === undefined) return;
    this.activeRepoPath = picked.description;
    await this.context.workspaceState.update(ACTIVE_REPO_KEY, picked.description);
    await this.broadcastRepoChanged('manual');
  }

  // -------------------------------------------------------------- commands

  private registerCommands(): void {
    const register = (id: string, handler: () => unknown): void => {
      this.disposables.push(vscode.commands.registerCommand(id, handler));
    };

    register('gitControl.openExplorer', () => this.openExplorer());
    register('gitControl.openPendingChanges', () =>
      vscode.commands.executeCommand('gitControl.pendingChanges.focus'),
    );
    register('gitControl.refresh', async () => {
      for (const repo of this.repositories.values()) repo.invalidate();
      await this.broadcastRepoChanged('manual');
      this.logger.info('command/refresh', MESSAGES.refreshed);
    });
    register('gitControl.connectGitHub', () => this.connectGitHub());
    register('gitControl.disconnectGitHub', () => this.disconnectGitHub());
    register('gitControl.showLogs', () => this.channel.show(true));
    // Only useful in multi-root workspaces; harmless elsewhere.
    register('gitControl.pickRepository', () => this.pickRepository());
  }

  /**
   * Serve historical blobs from a private, read-only scheme.
   *
   * Nothing is written to disk: the rev and path travel in the URI query and the
   * provider resolves them through `git show`. That keeps a diff of a deleted or
   * rewritten file possible without polluting the working tree.
   */
  private registerDiffProvider(): void {
    this.disposables.push(
      vscode.workspace.registerTextDocumentContentProvider(DIFF_SCHEME, {
        provideTextDocumentContent: (uri) => this.provideHistoricalContent(uri),
      }),
    );
  }

  private async provideHistoricalContent(uri: vscode.Uri): Promise<string> {
    const params = new URLSearchParams(uri.query);
    const rev = params.get('rev') ?? '';
    const filePath = params.get('path') ?? '';
    const folder = params.get('folder') ?? '';
    const repo = folder.length > 0 ? this.repositories.get(folder) : await this.resolveRepository();
    if (repo === undefined || repo === null) return MESSAGES.notARepo;

    try {
      const content = rev === ':' ? await repo.git.showIndexFile(filePath) : await repo.git.showFile(rev, filePath);
      // NUL bytes mean binary: a text diff would be noise, so say so instead.
      if (content.includes('\u0000')) return MESSAGES.diffBinary;
      if (Buffer.byteLength(content, 'utf8') > MAX_DIFF_BYTES) return MESSAGES.diffTrimmed;
      return content;
    } catch (err) {
      this.logger.info('diff/provider', err instanceof Error ? err.message : String(err));
      return MESSAGES.diffBinary;
    }
  }

  private registerViews(): void {
    this.disposables.push(
      vscode.window.registerWebviewViewProvider(
        'gitControl.pendingChanges',
        {
          resolveWebviewView: (view) => {
            view.webview.options = this.webviewOptions();
            view.webview.html = this.html(view.webview, 'pending');
            this.attachBridge(view.webview, view);
          },
        },
        // The view is cheap to rebuild; state is restored from the host.
        { webviewOptions: { retainContextWhenHidden: false } },
      ),
    );
  }

  // ------------------------------------------------------------------ diffs

  /**
   * Open a real diff editor for one path.
   *
   * Three cases, decided host-side from the live status so the webview cannot
   * disagree with the repository:
   *   - conflicted path      → merge editor (`git.openMergeEditor`), falling back
   *                            to a normal diff when the command is unavailable
   *   - `hash` given         → commit vs its parent, two historical revisions
   *   - no `hash`            → index vs HEAD when only the index changed,
   *                            otherwise working tree vs index
   */
  private async openDiff(payload: OpenDiffPayload): Promise<OpenDiffResult> {
    const repo = await this.resolveRepository();
    if (repo === null) return { opened: false, mode: 'worktree' };
    const root = await repo.repoRoot();

    if (payload.hash !== undefined) {
      return this.openCommitDiff(repo.folderPath, payload.path, payload.hash, payload.parent);
    }

    const status = await repo.status();
    const conflicted = status.conflicts.some((c) => c.path === payload.path);
    if (conflicted) {
      const opened = await this.openMergeEditor(root, payload.path);
      if (opened) return { opened: true, mode: 'merge' };
      // Fall through to a plain diff so the user is never stuck.
    }

    const entry = status.changes.find((c) => c.path === payload.path);
    const onDisk = vscode.Uri.file(path.join(root, payload.path));
    // Only staged, nothing left in the working tree: compare index against HEAD.
    if (entry !== undefined && entry.staged && !entry.unstaged && !entry.untracked) {
      const head = this.historicalUri(repo.folderPath, 'HEAD', payload.path, `${payload.path} (HEAD)`);
      const index = this.historicalUri(repo.folderPath, ':', payload.path, `${payload.path} (index)`);
      await this.showDiff(head, index, `${basenameOf(payload.path)} · HEAD ↔ index`);
      return { opened: true, mode: 'index' };
    }

    // Untracked files have no committed side; open the file itself.
    if (entry !== undefined && entry.untracked) {
      await vscode.window.showTextDocument(onDisk, { preview: true });
      return { opened: true, mode: 'worktree' };
    }

    const left = this.historicalUri(repo.folderPath, ':', payload.path, `${payload.path} (index)`);
    await this.showDiff(left, onDisk, `${basenameOf(payload.path)} · index ↔ folder kerja`);
    return { opened: true, mode: 'worktree' };
  }

  private async openCommitDiff(
    folder: string,
    filePath: string,
    hash: string,
    parent: string | undefined,
  ): Promise<OpenDiffResult> {
    const repo = this.repositories.get(folder);
    const base = parent ?? (await this.firstParentOf(repo, hash));
    const right = this.historicalUri(folder, hash, filePath, `${filePath} (${short(hash)})`);
    if (base === null) {
      // Root commit: nothing to compare against, so show the added file alone.
      await vscode.window.showTextDocument(right, { preview: true });
      return { opened: true, mode: 'commit' };
    }
    const left = this.historicalUri(folder, base, filePath, `${filePath} (${short(base)})`);
    await this.showDiff(left, right, `${basenameOf(filePath)} · ${short(base)} ↔ ${short(hash)}`);
    return { opened: true, mode: 'commit' };
  }

  private async firstParentOf(repo: RepositoryService | undefined, hash: string): Promise<string | null> {
    if (repo === undefined) return null;
    const meta = await repo.git.commitMeta(hash);
    return meta?.parents[0] ?? null;
  }

  /**
   * `git-control:` URI carrying the revision, the repo-relative path, and the
   * workspace folder. The path segment keeps the real file name so VS Code picks
   * the right language for syntax highlighting.
   */
  private historicalUri(folder: string, rev: string, filePath: string, label: string): vscode.Uri {
    const query = new URLSearchParams({ rev, path: filePath, folder }).toString();
    return vscode.Uri.from({
      scheme: DIFF_SCHEME,
      path: `/${filePath}`,
      query,
      fragment: label,
    });
  }

  private async showDiff(left: vscode.Uri, right: vscode.Uri, title: string): Promise<void> {
    await vscode.commands.executeCommand('vscode.diff', left, right, title, { preview: true });
  }

  /** `git.openMergeEditor` exists only when the built-in git extension is active. */
  private async openMergeEditor(root: string, filePath: string): Promise<boolean> {
    const commands = await vscode.commands.getCommands(true);
    if (!commands.includes('git.openMergeEditor')) return false;
    try {
      await vscode.commands.executeCommand(
        'git.openMergeEditor',
        vscode.Uri.file(path.join(root, filePath)),
      );
      return true;
    } catch (err) {
      this.logger.info('diff/mergeEditor', err instanceof Error ? err.message : String(err));
      return false;
    }
  }

  private openExplorer(): void {
    if (this.panel !== undefined) {
      this.panel.reveal();
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      'gitControl.explorer',
      'Git Control',
      vscode.ViewColumn.Active,
      {
        ...this.webviewOptions(),
        // The graph holds a large laid-out DAG plus scroll position; rebuilding
        // it on every tab switch is the one case where retaining pays off.
        retainContextWhenHidden: true,
      },
    );
    panel.webview.html = this.html(panel.webview, 'explorer');
    this.attachBridge(panel.webview, panel);
    panel.onDidDispose(() => {
      this.panel = undefined;
    });
    this.panel = panel;
  }

  private webviewOptions(): vscode.WebviewOptions {
    return {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.context.extensionUri, 'dist'),
        vscode.Uri.joinPath(this.context.extensionUri, 'resources'),
      ],
    };
  }

  private attachBridge(webview: vscode.Webview, owner: { onDidDispose?: vscode.Event<void> }): void {
    const bridge = new MessageBridge(webview as unknown as WebviewLike, this.bridgeHost());
    this.bridges.add(bridge);
    const detach = (): void => {
      bridge.dispose();
      this.bridges.delete(bridge);
    };
    if (owner.onDidDispose !== undefined) owner.onDidDispose(detach);
    else this.disposables.push({ dispose: detach });
  }

  private bridgeHost(): BridgeHost {
    return {
      logger: this.logger,
      resolveRepository: () => this.resolveRepository(),
      settings: () => this.settingsSnapshot(),
      setUiPreference: (payload) => this.setUiPreference(payload),
      githubAuth: () => this.githubAuth(),
      connectGitHub: () => this.connectGitHub(),
      disconnectGitHub: () => this.disconnectGitHub(),
      openDiff: (payload) => this.openDiff(payload),
      showLogs: () => this.channel.show(true),
      openExternal: (url) => this.openExternal(url),
      githubRepo: (payload) => this.githubRepo(payload),
      githubPullRequests: (payload) => this.githubPullRequests(payload),
      githubLinkage: () => this.githubLinkage(),
    };
  }

  private async broadcastRepoChanged(reason: 'fs' | 'action' | 'manual'): Promise<void> {
    for (const bridge of this.bridges) await bridge.notifyRepoChanged(reason);
  }

  // -------------------------------------------------------------- settings

  private settingsSnapshot(): SettingsSnapshot {
    const config = vscode.workspace.getConfiguration('gitControl');
    return {
      gitPath: this.gitPath ?? '',
      commitLimit: Math.min(config.get<number>('commitLimit', MAX_COMMIT_LIMIT), MAX_COMMIT_LIMIT),
      pageSize: config.get<number>('pageSize', 500),
      showIgnoredFiles: config.get<boolean>('showIgnoredFiles', false),
      githubApiUrl: config.get<string>('githubApiUrl', 'https://api.github.com'),
      fetchStalenessMs: config.get<number>('fetchStalenessMs', 300_000),
      ui: this.uiPreferences(),
    };
  }

  private uiPreferences(): UiPreferences {
    const stored = this.context.workspaceState.get<Partial<UiPreferences>>(UI_PREFS_KEY, {});
    return {
      zoom: typeof stored.zoom === 'number' ? stored.zoom : 1,
      branchFilter: typeof stored.branchFilter === 'string' ? stored.branchFilter : '',
    };
  }

  /** UI prefs live in `workspaceState`. Tokens never do — they go to SecretStorage. */
  private async setUiPreference(payload: SettingsSetPayload): Promise<SettingsSnapshot> {
    const prefs = this.uiPreferences();
    if (payload.key === 'zoom' && typeof payload.value === 'number') prefs.zoom = payload.value;
    if (payload.key === 'branchFilter' && typeof payload.value === 'string') prefs.branchFilter = payload.value;
    await this.context.workspaceState.update(UI_PREFS_KEY, prefs);
    return this.settingsSnapshot();
  }

  // ---------------------------------------------------------------- github

  /**
   * GitHub client for the active repository.
   *
   * API base resolution, documented because the rule is not obvious:
   *   1. `gitControl.githubApiUrl` when the user changed it away from the default
   *      → always wins, so an explicit Enterprise base is never second-guessed
   *   2. otherwise, if the detected remote host is not `github.com`, derive
   *      `https://HOST/api/v3` — the fixed GitHub Enterprise Server layout
   *   3. otherwise `https://api.github.com`
   *
   * HARD RULE: this client is metadata only. Push and fetch always go through the
   * Git CLI in `git.ts`; nothing here transfers git objects.
   */
  private async githubClient(): Promise<{ client: GitHubClient; apiUrl: string }> {
    const token = (await this.context.secrets.get(TOKEN_SECRET_KEY)) ?? null;
    const remote = await this.detectRemote();
    const apiUrl = this.resolveApiUrl(remote);
    const cached = this.github;
    if (cached !== undefined && cached.apiUrl === apiUrl && cached.token === token) {
      return { client: cached.client, apiUrl };
    }
    const client = new GitHubClient({
      apiUrl,
      token,
      logger: (line) => this.logger.info('github/client', line),
    });
    this.github = { client, apiUrl, token };
    return { client, apiUrl };
  }

  /** See {@link githubClient} for the precedence rules. */
  private resolveApiUrl(remote: ParsedRemoteUrl | null): string {
    const configured = vscode.workspace
      .getConfiguration('gitControl')
      .get<string>('githubApiUrl', DEFAULT_API_URL)
      .trim();
    if (configured.length > 0 && configured !== DEFAULT_API_URL) return configured.replace(/\/+$/, '');
    if (remote !== null && !remote.isGitHub) return `https://${remote.host}/api/v3`;
    return DEFAULT_API_URL;
  }

  /** First remote we can turn into `owner/repo`, preferring `origin`. */
  private async detectRemote(): Promise<ParsedRemoteUrl | null> {
    const repo = await this.resolveRepository();
    if (repo === null) return null;
    let remotes: Array<{ name: string; fetchUrl: string; pushUrl: string }>;
    try {
      remotes = await repo.git.remoteList();
    } catch {
      return null;
    }
    const ordered = [...remotes].sort((a, b) => Number(b.name === 'origin') - Number(a.name === 'origin'));
    for (const entry of ordered) {
      const parsed = parseRemoteUrl(entry.fetchUrl) ?? parseRemoteUrl(entry.pushUrl);
      if (parsed !== null) return parsed;
    }
    return null;
  }

  /**
   * Connection state. A stored token that the API rejects is reported as NOT
   * connected and deleted from SecretStorage, per the PRD: a token that cannot
   * work is worse than no token, because it makes every later call fail.
   */
  private async githubAuth(): Promise<GitHubAuthState> {
    const token = await this.context.secrets.get(TOKEN_SECRET_KEY);
    const { client, apiUrl } = await this.githubClient();
    if (token === undefined || token.length === 0) {
      return { connected: false, login: null, scopes: [], apiUrl };
    }
    try {
      const viewer = await client.viewer();
      const warning = await this.scopeWarning(viewer.data.scopes);
      return {
        connected: true,
        login: viewer.data.login,
        scopes: viewer.data.scopes,
        apiUrl,
        ...(warning === null ? {} : { scopeWarning: warning }),
      };
    } catch (err) {
      if (err instanceof GitHubError && err.code === 'AUTH_ERROR') {
        await this.context.secrets.delete(TOKEN_SECRET_KEY);
        this.github = undefined;
        this.logger.info('github/auth', 'invalid token deleted');
        return {
          connected: false,
          login: null,
          scopes: [],
          invalidToken: true,
          apiUrl,
        };
      }
      // Network or rate-limit trouble is not an auth verdict: the token stands.
      this.logger.info('github/auth', err instanceof Error ? err.message : String(err));
      return { connected: true, login: null, scopes: [], apiUrl };
    }
  }

  /** Warn only when it matters: a private repository plus a token missing the scope. */
  private async scopeWarning(scopes: readonly string[]): Promise<string | null> {
    if (hasPrivateScope(scopes)) return null;
    const remote = await this.detectRemote();
    if (remote === null) return null;
    try {
      const { client } = await this.githubClient();
      const repo = await client.repo(remote.owner, remote.repo);
      return repo.data.private ? GITHUB_MESSAGES.scopeMissing : null;
    } catch {
      // Cannot tell whether it is private; do not cry wolf.
      return null;
    }
  }

  private async connectGitHub(): Promise<GitHubAuthState> {
    const token = await vscode.window.showInputBox({
      prompt: MESSAGES.githubPrompt,
      password: true,
      ignoreFocusOut: true,
    });
    if (token === undefined || token.trim().length === 0) return this.githubAuth();
    await this.context.secrets.store(TOKEN_SECRET_KEY, token.trim());
    // Drop the cached client so the new token is picked up, cache and all.
    this.github = undefined;
    this.logger.info('github/connect', 'token stored');
    const state = await this.githubAuth();
    if (state.connected) void vscode.window.showInformationMessage(MESSAGES.githubConnected);
    else void vscode.window.showWarningMessage(GITHUB_MESSAGES.invalidToken);
    return state;
  }

  private async disconnectGitHub(): Promise<GitHubAuthState> {
    await this.context.secrets.delete(TOKEN_SECRET_KEY);
    this.github = undefined;
    this.logger.info('github/disconnect', 'token cleared');
    void vscode.window.showInformationMessage(MESSAGES.githubDisconnected);
    return this.githubAuth();
  }

  private async githubRepo(payload: GitHubRepoPayload): Promise<GitHubRepoInfo> {
    const { client } = await this.githubClient();
    const result = await client.repo(payload.owner, payload.repo);
    const warning =
      result.data.private && client.hasToken ? await this.scopeWarningForStoredToken() : null;
    return {
      defaultBranch: result.data.defaultBranch,
      private: result.data.private,
      htmlUrl: result.data.htmlUrl,
      rateLimit: client.rateLimit(result.cached),
      ...(warning === null ? {} : { scopeWarning: warning }),
    };
  }

  /** Scope check that reuses the cached viewer read rather than re-probing the repo. */
  private async scopeWarningForStoredToken(): Promise<string | null> {
    try {
      const { client } = await this.githubClient();
      const viewer = await client.viewer();
      return hasPrivateScope(viewer.data.scopes) ? null : GITHUB_MESSAGES.scopeMissing;
    } catch {
      return null;
    }
  }

  private async githubPullRequests(payload: PullRequestsPayload): Promise<PullRequestsResult> {
    const { client } = await this.githubClient();
    const result = await client.pullRequests(payload.owner, payload.repo, {
      state: payload.state ?? 'open',
    });
    return { pullRequests: result.data, rateLimit: client.rateLimit(result.cached) };
  }

  /** GitHub linkage for the detected remote, used for "Buka di GitHub". */
  private async githubLinkage(): Promise<GitHubLinkage> {
    const remote = await this.detectRemote();
    if (remote === null) {
      return {
        available: false,
        host: null,
        owner: null,
        repo: null,
        webUrl: null,
        commitUrlTemplate: null,
        apiUrl: null,
      };
    }
    const webUrl = webUrlOf(remote);
    return {
      available: true,
      host: remote.host,
      owner: remote.owner,
      repo: remote.repo,
      webUrl,
      commitUrlTemplate: `${webUrl}/commit/{hash}`,
      apiUrl: this.resolveApiUrl(remote),
    };
  }

  /** Opening external links is host-side only; the webview CSP forbids navigation. */
  private async openExternal(url: string): Promise<boolean> {
    return vscode.env.openExternal(vscode.Uri.parse(url, true));
  }

  // ------------------------------------------------------------------ html


  /**
   * Strict CSP: `default-src 'none'`, scripts only with the per-load nonce.
   * Styles carry the same nonce, so no `unsafe-inline` anywhere.
   */
  private html(webview: vscode.Webview, view: 'explorer' | 'pending'): string {
    const nonce = makeNonce();
    const script = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview.js'),
    );
    const style = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview.css'),
    );
    const csp = [
      "default-src 'none'",
      `img-src ${webview.cspSource} data:`,
      `style-src ${webview.cspSource} 'nonce-${nonce}'`,
      `script-src 'nonce-${nonce}'`,
      `font-src ${webview.cspSource}`,
      "connect-src 'none'",
    ].join('; ');

    return `<!DOCTYPE html>
<html lang="id">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link nonce="${nonce}" rel="stylesheet" href="${style.toString()}">
<title>Git Control</title>
</head>
<body data-view="${view}">
<div id="root"></div>
<script nonce="${nonce}" src="${script.toString()}"></script>
</body>
</html>`;
  }
}

/** 32 hex chars of CSPRNG output, fresh per webview load. */
function makeNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Trailing segment of a repo-relative path, for a readable diff tab title. */
function basenameOf(filePath: string): string {
  const parts = filePath.split(/[\\/]/);
  return parts[parts.length - 1] ?? filePath;
}

function short(rev: string): string {
  return rev.length > 7 && /^[0-9a-f]+$/i.test(rev) ? rev.slice(0, 7) : rev;
}
