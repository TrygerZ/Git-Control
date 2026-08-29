// Extension host entry point. Command/webview wiring lands in a later phase.
import * as vscode from 'vscode';

export function activate(_context: vscode.ExtensionContext): void {
  // Intentionally empty: foundation phase only.
}

export function deactivate(): void {
  // Intentionally empty.
}
