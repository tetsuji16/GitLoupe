import * as vscode from 'vscode';
import { GitService } from './git.js';
import { GitContentProvider, GraphPanel, RepositoryViewProvider, showFileHistory } from './ui.js';
import { BlameController, BlameHoverProvider, BlameCodeLensProvider } from './blame.js';

export function activate(context: vscode.ExtensionContext): void {
  const git = new GitService();
  const graph = new GraphPanel(context.extensionUri, git);
  const repositoryView = new RepositoryViewProvider(context.extensionUri, git, () => graph.show());
  const blame = new BlameController(git, graph);

  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider('gitloupe', new GitContentProvider(git)),
    vscode.window.registerWebviewViewProvider(RepositoryViewProvider.viewType, repositoryView),
    blame,
    vscode.languages.registerHoverProvider({ scheme: 'file' }, new BlameHoverProvider(blame)),
    vscode.languages.registerCodeLensProvider({ scheme: 'file' }, new BlameCodeLensProvider(blame)),
    vscode.commands.registerCommand('gitloupe.openGraph', () => graph.show()),
    vscode.commands.registerCommand('gitloupe.openFileHistory', (resource?: vscode.Uri) =>
      showFileHistory(context.extensionUri, git, resource)
    ),
    vscode.commands.registerCommand('gitloupe.refresh', async () => {
      await Promise.all([graph.refresh(), repositoryView.refresh()]);
    }),
    vscode.commands.registerCommand(
      'gitloupe.openCommit',
      (args?: { hash?: string; root?: string }) => blame.openCommit(args)
    ),
    vscode.commands.registerCommand(
      'gitloupe.copyHash',
      (args?: { hash?: string; root?: string }) => blame.copyHash(args)
    ),
    vscode.commands.registerCommand('gitloupe.toggleBlame', () => blame.toggleBlame()),
    vscode.commands.registerCommand('gitloupe.toggleHeatmap', () => blame.toggleHeatmap())
  );

  const onEditor = (editor?: vscode.TextEditor) => void blame.track(editor);
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(onEditor),
    vscode.window.onDidChangeTextEditorSelection(event => blame.onSelection(event.textEditor)),
    vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration('gitloupe.blame')) void blame.track();
    }),
    vscode.workspace.onDidSaveTextDocument(document => blame.invalidate(document.uri.toString()))
  );

  void blame.track();
}

export function deactivate(): void {
  // VS Code disposes registered resources through ExtensionContext.
}
