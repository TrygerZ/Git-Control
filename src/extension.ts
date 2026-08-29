/**
 * Extension host activation.
 *
 * Wires: git discovery → per-folder repository registry → watcher → message
 * bridge → webview panel + view. Everything created here is registered on the
 * context subscriptions so `deactivate` is a no-op beyond VS Code's own
 * disposal pass.
 */
import * as vscode from 'vscode';
import { MessageBridge, type BridgeHost, type WebviewLike } from './bridge';
import { GitRunner } from './git';
import { Logger } from './logger';
import { MAX_COMMIT_LIMIT, RepositoryService } from './repository';
import { RepoWatcher } from './watcher';
import type { GitHubAuthState, SettingsSetPayload, SettingsSnapshot, UiPreferences } from './messages';

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
} as const;

const GIT_INSTALL_URL = 'https://git-scm.com/downloads';
const TOKEN_SECRET_KEY = 'gitControl.githubToken';
const UI_PREFS_KEY = 'gitControl.uiPreferences';
const ACTIVE_REPO_KEY = 'gitControl.activeRepo';

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

  constructor(context: vscode.ExtensionContext, logger: Logger, channel: vscode.OutputChannel) {
    this.context = context;
    this.logger = logger;
    this.channel = channel;
  }

  async initialize(): Promise<void> {
    this.registerCommands();
    this.registerViews();

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

  private async githubAuth(): Promise<GitHubAuthState> {
    const token = await this.context.secrets.get(TOKEN_SECRET_KEY);
    // Login and scopes require an API call; that is a later phase.
    return { connected: token !== undefined, login: null, scopes: [] };
  }

  private async connectGitHub(): Promise<GitHubAuthState> {
    const token = await vscode.window.showInputBox({
      prompt: MESSAGES.githubPrompt,
      password: true,
      ignoreFocusOut: true,
    });
    if (token === undefined || token.trim().length === 0) return this.githubAuth();
    await this.context.secrets.store(TOKEN_SECRET_KEY, token.trim());
    this.logger.info('github/connect', 'token stored');
    void vscode.window.showInformationMessage(MESSAGES.githubConnected);
    return this.githubAuth();
  }

  private async disconnectGitHub(): Promise<GitHubAuthState> {
    await this.context.secrets.delete(TOKEN_SECRET_KEY);
    this.logger.info('github/disconnect', 'token cleared');
    void vscode.window.showInformationMessage(MESSAGES.githubDisconnected);
    return this.githubAuth();
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
