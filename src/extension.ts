import * as vscode from 'vscode';
import { GitService } from './git.js';
import { GitContentProvider, GraphPanel, RepositoryViewProvider, showFileHistory } from './ui.js';
import { BlameController, BlameHoverProvider, BlameCodeLensProvider } from './blame.js';
import { LaunchpadPanel } from './launchpad.js';
import { OllamaController } from './ollama.js';

const errorMessageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export function activate(context: vscode.ExtensionContext): void {
  const git = new GitService();
  const ollama = new OllamaController(context.secrets, git);
  const graph = new GraphPanel(context.extensionUri, git, ollama);
  const repositoryView = new RepositoryViewProvider(context.extensionUri, git, () => graph.show());
  const launchpad = new LaunchpadPanel(context.extensionUri, git, async () => {
    await Promise.all([graph.refresh(), repositoryView.refresh()]);
  }, context.globalState);
  const blame = new BlameController(git, graph);
  const gitWatcher = vscode.workspace.createFileSystemWatcher('**/.git/{HEAD,index,packed-refs,refs/**}');
  let refreshTimer: NodeJS.Timeout | undefined;
  const queueRepositoryRefresh = (): void => {
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      refreshTimer = undefined;
      void Promise.all([graph.refresh(), repositoryView.refresh()]);
    }, 350);
  };

  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider('gitloupe', new GitContentProvider(git)),
    vscode.window.registerWebviewViewProvider(RepositoryViewProvider.viewType, repositoryView),
    gitWatcher,
    new vscode.Disposable(() => {
      if (refreshTimer) clearTimeout(refreshTimer);
    }),
    blame,
    vscode.languages.registerHoverProvider({ scheme: 'file' }, new BlameHoverProvider(blame)),
    vscode.languages.registerCodeLensProvider({ scheme: 'file' }, new BlameCodeLensProvider(blame)),
    vscode.commands.registerCommand('gitloupe.openGraph', () => graph.show()),
    vscode.commands.registerCommand('gitloupe.openFileHistory', (resource?: vscode.Uri) =>
      showFileHistory(context.extensionUri, git, resource)
    ),
    vscode.commands.registerCommand('gitloupe.openRepositoryHistory', () =>
      showFileHistory(context.extensionUri, git, undefined, true)
    ),
    vscode.commands.registerCommand('gitloupe.openLaunchpad', () => launchpad.show()),
    vscode.commands.registerCommand('gitloupe.refresh', async () => {
      await Promise.all([graph.refresh(), repositoryView.refresh()]);
    }),
    vscode.commands.registerCommand('gitloupe.manageSelectedFiles', () => runSafely(() => graph.manageSelectedFiles())),
    vscode.commands.registerCommand('gitloupe.manageWorktree', () => runSafely(() => graph.manageWorktree())),
    vscode.commands.registerCommand(
      'gitloupe.openCommit',
      (args?: { hash?: string; root?: string }) => blame.openCommit(args)
    ),
    vscode.commands.registerCommand(
      'gitloupe.copyHash',
      (args?: { hash?: string; root?: string }) => blame.copyHash(args)
    ),
    vscode.commands.registerCommand('gitloupe.toggleBlame', () => blame.toggleBlame()),
    vscode.commands.registerCommand('gitloupe.toggleHeatmap', () => blame.toggleHeatmap()),
    vscode.commands.registerCommand('gitloupe.toggleFileBlame', () => blame.toggleFileBlame()),
    vscode.commands.registerCommand('gitloupe.diffWithPrevious', () => runSafely(() => blame.diffWithPrevious())),
    vscode.commands.registerCommand('gitloupe.fileRevisionPrevious', () => runSafely(() => blame.navigateFileRevision('previous'))),
    vscode.commands.registerCommand('gitloupe.fileRevisionNext', () => runSafely(() => blame.navigateFileRevision('next'))),
    vscode.commands.registerCommand('gitloupe.ollama.selectModel', () => runSafely(() => ollama.chooseModel())),
    vscode.commands.registerCommand('gitloupe.ollama.setApiKey', () => runSafely(() => ollama.setApiKey())),
    vscode.commands.registerCommand('gitloupe.openStash', async (args?: { root?: string; ref?: string }) => {
      if (!args?.root || !args.ref) return;
      try {
        const patch = await git.stashShow(args.root, args.ref);
        const doc = await vscode.workspace.openTextDocument({ content: patch || 'No diff available.', language: 'diff' });
        await vscode.window.showTextDocument(doc, { preview: true });
      } catch (error) {
        void vscode.window.showErrorMessage(`GitLoupe: ${errorMessageOf(error)}`);
      }
    }),
    vscode.commands.registerCommand('gitloupe.popStash', async (args?: { root?: string; ref?: string }) => {
      if (!args?.root || !args.ref) return;
      const answer = await vscode.window.showWarningMessage(`Pop ${args.ref}? This applies and removes the stash.`, { modal: true }, 'Pop');
      if (answer !== 'Pop') return;
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Popping ${args.ref}…` }, () => git.stashPop(args.root!, args.ref!));
      await Promise.all([graph.refresh(), repositoryView.refresh()]);
    }),
    vscode.commands.registerCommand('gitloupe.applyStash', async (args?: { root?: string; ref?: string }) => {
      if (!args?.root || !args.ref) return;
      const answer = await vscode.window.showWarningMessage(`Apply ${args.ref}?`, { modal: true }, 'Apply');
      if (answer !== 'Apply') return;
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Applying ${args.ref}…` }, () => git.stashApply(args.root!, args.ref!));
      await Promise.all([graph.refresh(), repositoryView.refresh()]);
    }),
    vscode.commands.registerCommand('gitloupe.dropStash', async (args?: { root?: string; ref?: string }) => {
      if (!args?.root || !args.ref) return;
      const answer = await vscode.window.showWarningMessage(`Drop ${args.ref}? This deletes the stash permanently.`, { modal: true }, 'Drop');
      if (answer !== 'Drop') return;
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Dropping ${args.ref}…` }, () => git.stashDrop(args.root!, args.ref!));
      await Promise.all([graph.refresh(), repositoryView.refresh()]);
    }),
    vscode.commands.registerCommand('gitloupe.createStash', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        void vscode.window.showInformationMessage('GitLoupe: Open a file inside a Git repository first.');
        return;
      }
      let repo;
      try {
        repo = await git.findRepository(editor.document.uri.fsPath);
      } catch {
        void vscode.window.showInformationMessage('GitLoupe: The active file is not in a Git repository.');
        return;
      }
      const message = await vscode.window.showInputBox({
        title: 'Stash changes',
        prompt: 'Stash message (optional)',
        value: `WIP on ${repo.branch}`
      });
      if (message === undefined) return;
      try {
        await git.createStash(repo.root, message.trim() || undefined);
        await Promise.all([graph.refresh(), repositoryView.refresh()]);
        void vscode.window.showInformationMessage('GitLoupe: Changes stashed.');
      } catch (error) {
        void vscode.window.showErrorMessage(`GitLoupe: ${errorMessageOf(error)}`);
      }
    })
  );

  const onEditor = (editor?: vscode.TextEditor) => void blame.track(editor);
  context.subscriptions.push(
    gitWatcher.onDidChange(queueRepositoryRefresh),
    gitWatcher.onDidCreate(queueRepositoryRefresh),
    gitWatcher.onDidDelete(queueRepositoryRefresh),
    vscode.window.onDidChangeActiveTextEditor(onEditor),
    vscode.window.onDidChangeTextEditorSelection(event => blame.onSelection(event.textEditor)),
    vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration('gitloupe.blame')) void blame.track();
    }),
    vscode.workspace.onDidSaveTextDocument(document => {
      blame.invalidate(document.uri.toString());
      queueRepositoryRefresh();
    }),
    vscode.workspace.onDidCreateFiles(queueRepositoryRefresh),
    vscode.workspace.onDidDeleteFiles(queueRepositoryRefresh),
    vscode.workspace.onDidRenameFiles(queueRepositoryRefresh)
  );

  void blame.track();
}

export function deactivate(): void {
  // VS Code disposes registered resources through ExtensionContext.
}

async function runSafely(action: () => Promise<void>): Promise<void> {
  try {
    await action();
  } catch (error) {
    void vscode.window.showErrorMessage(`GitLoupe: ${errorMessageOf(error)}`);
  }
}
