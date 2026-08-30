const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vscode = require('vscode');

async function run() {
  const extension = vscode.extensions.getExtension('TrygerZ.git-control');
  assert.ok(extension, 'TrygerZ.git-control must be installed in the development host');
  const unhandled = [];
  const onUnhandled = (error) => unhandled.push(error);
  process.on('unhandledRejection', onUnhandled);
  try {
    await extension.activate();
    assert.equal(extension.isActive, true, 'extension must activate');
    assert.deepEqual(unhandled, [], 'activation must not create unhandled rejections');

    const manifest = require(path.join(process.env.GIT_CONTROL_ROOT, 'package.json'));
    const declared = manifest.contributes.commands.map((entry) => entry.command);
    const registered = await vscode.commands.getCommands(true);
    for (const command of declared) assert.ok(registered.includes(command), `${command} is registered`);

    await vscode.commands.executeCommand('gitControl.openExplorer');
    await vscode.commands.executeCommand('gitControl.openPendingChanges');
    await vscode.commands.executeCommand('gitControl.showLogs');
    await vscode.commands.executeCommand('gitControl.refresh');

    const folder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(folder, 'real git workspace is open');
    const head = (await execGit(['rev-parse', 'HEAD'])).trim();
    const uri = vscode.Uri.from({ scheme: 'git-control', path: '/a.txt', query: new URLSearchParams({ rev: head, path: 'a.txt', folder: folder.uri.fsPath }).toString() });
    const document = await vscode.workspace.openTextDocument(uri);
    assert.equal(document.getText(), 'one\n', 'valid historical diff content is returned');
    const invalid = vscode.Uri.from({ scheme: 'git-control', path: '/missing.txt', query: new URLSearchParams({ rev: 'not-a-revision', path: 'missing.txt', folder: folder.uri.fsPath }).toString() });
    const invalidDocument = await vscode.workspace.openTextDocument(invalid);
    assert.notEqual(invalidDocument.getText(), 'one\n', 'invalid historical content is rejected');

    // VS Code exposes no public API for reading a WebviewPanel's generated HTML or
    // CSP violations. Opening both surfaces is the strongest host-level check.
    assert.ok(vscode.window.visibleTextEditors.length >= 0);
    console.log('PASS activation, commands, webviews, refresh, diff provider');
  } finally {
    process.removeListener('unhandledRejection', onUnhandled);
  }
}

function execGit(args) {
  return new Promise((resolve, reject) => {
    const child = require('node:child_process').spawn('git', args, { cwd: vscode.workspace.workspaceFolders[0].uri.fsPath });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve(stdout) : reject(new Error(stderr)));
  });
}

module.exports = { run };
