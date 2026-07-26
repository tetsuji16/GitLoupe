import * as vscode from 'vscode';
import { GitService } from './git.js';
import { GitContentProvider, GraphPanel, RepositoryViewProvider, showFileHistory } from './ui.js';

export function activate(context: vscode.ExtensionContext): void {
  const git = new GitService();
  const graph = new GraphPanel(context.extensionUri, git);
  const repositoryView = new RepositoryViewProvider(context.extensionUri, git, () => graph.show());

  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider('gitloupe', new GitContentProvider(git)),
    vscode.window.registerWebviewViewProvider(RepositoryViewProvider.viewType, repositoryView),
    vscode.commands.registerCommand('gitloupe.openGraph', () => graph.show()),
    vscode.commands.registerCommand('gitloupe.openFileHistory', (resource?: vscode.Uri) =>
      showFileHistory(context.extensionUri, git, resource)
    ),
    vscode.commands.registerCommand('gitloupe.refresh', async () => {
      await Promise.all([graph.refresh(), repositoryView.refresh()]);
    })
  );
}

export function deactivate(): void {
  // VS Code disposes registered resources through ExtensionContext.
}
