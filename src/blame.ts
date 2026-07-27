import * as path from 'node:path';
import * as vscode from 'vscode';
import { GitService } from './git.js';
import type { BlameLine } from './parsers.js';
import type { GraphPanel } from './ui.js';

export interface RepoRef {
  root: string;
  rel: string;
}

const HEAT_COLORS = [
  'rgba(229,20,0,0.55)',
  'rgba(197,134,192,0.5)',
  'rgba(215,186,31,0.45)',
  'rgba(78,201,176,0.4)',
  'rgba(86,156,214,0.35)'
];

const HEAT_BG = [
  'rgba(229,20,0,0.10)',
  'rgba(197,134,192,0.08)',
  'rgba(215,186,31,0.07)',
  'rgba(78,201,176,0.06)',
  'rgba(86,156,214,0.05)'
];

export class BlameController implements vscode.Disposable {
  private readonly currentLineType: vscode.TextEditorDecorationType;
  private readonly heatTypes: vscode.TextEditorDecorationType[];
  private readonly statusBar: vscode.StatusBarItem;
  private readonly fileCache = new Map<string, { version: number; lines: BlameLine[] }>();
  private readonly repoCache = new Map<string, RepoRef | null>();
  private debounce: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly git: GitService, private readonly graph: GraphPanel) {
    this.currentLineType = vscode.window.createTextEditorDecorationType({
      after: {
        color: new vscode.ThemeColor('editorCodeLens.foreground'),
        fontStyle: 'italic'
      },
      rangeBehavior: vscode.DecorationRangeBehavior.ClosedOpen
    });
    this.heatTypes = HEAT_COLORS.map(
      (color, index) =>
        vscode.window.createTextEditorDecorationType({
          isWholeLine: true,
          backgroundColor: HEAT_BG[index],
          overviewRulerLane: vscode.OverviewRulerLane.Left,
          overviewRulerColor: color
        })
    );
    this.statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this.statusBar.command = 'gitloupe.openCommit';
    this.statusBar.tooltip = 'GitLoupe: open the commit at the cursor';
  }

  async track(editor: vscode.TextEditor | undefined = vscode.window.activeTextEditor): Promise<void> {
    if (!editor || !this.config('blame.enabled', true)) {
      this.clearActive();
      return;
    }
    const repo = await this.repoFor(editor.document);
    if (!repo) {
      this.clearActive();
      return;
    }
    await this.renderCurrentLine(editor, repo);
    await this.renderHeatmap(editor, repo);
  }

  onSelection(editor: vscode.TextEditor | undefined): void {
    if (!editor) return;
    clearTimeout(this.debounce);
    this.debounce = setTimeout(() => void this.track(editor), 80);
  }

  invalidate(key: string): void {
    this.fileCache.delete(key);
  }

  async openCommit(args?: { hash?: string; root?: string }): Promise<void> {
    const target = await this.resolveHash(args);
    if (!target) {
      void vscode.window.showInformationMessage('GitLoupe: No committed change at the cursor.');
      return;
    }
    await this.graph.revealCommit(target.root, target.hash);
  }

  async copyHash(args?: { hash?: string; root?: string }): Promise<void> {
    const target = await this.resolveHash(args);
    if (!target) {
      void vscode.window.showInformationMessage('GitLoupe: No committed change at the cursor.');
      return;
    }
    await vscode.env.clipboard.writeText(target.hash);
    void vscode.window.showInformationMessage(`GitLoupe: Copied ${target.hash.slice(0, 12)}`);
  }

  async toggleBlame(): Promise<void> {
    const next = !this.config('blame.enabled', true);
    await vscode.workspace.getConfiguration('gitloupe').update('blame.enabled', next, vscode.ConfigurationTarget.Global);
    void vscode.window.showInformationMessage(`GitLoupe: Line blame ${next ? 'enabled' : 'disabled'}.`);
    await this.track();
  }

  async toggleHeatmap(): Promise<void> {
    const next = !this.config('blame.heatmap', false);
    await vscode.workspace.getConfiguration('gitloupe').update('blame.heatmap', next, vscode.ConfigurationTarget.Global);
    void vscode.window.showInformationMessage(`GitLoupe: Heatmap ${next ? 'enabled' : 'disabled'}.`);
    const editor = vscode.window.activeTextEditor;
    if (editor) {
      const repo = await this.repoFor(editor.document);
      if (repo) await this.renderHeatmap(editor, repo);
    }
  }

  async hoverFor(document: vscode.TextDocument, position: vscode.Position): Promise<vscode.Hover | undefined> {
    if (!this.config('blame.enabled', true)) return undefined;
    const repo = await this.repoFor(document);
    if (!repo) return undefined;
    let lines: BlameLine[];
    try {
      lines = await this.fileBlame(document, repo);
    } catch {
      return undefined;
    }
    const blame = lines.find(entry => entry.line === position.line + 1);
    if (!blame) return undefined;
    const markdown = new vscode.MarkdownString();
    markdown.isTrusted = true;
    if (blame.uncommitted) {
      markdown.appendMarkdown('**Uncommitted change**\n\nThis line has not been committed yet.');
      return new vscode.Hover(markdown, document.lineAt(position.line).range);
    }
    const encoded = encodeURIComponent(JSON.stringify({ hash: blame.hash, root: repo.root }));
    markdown.appendMarkdown(`**${blame.author}** <${blame.email}>\n\n`);
    markdown.appendMarkdown(`${new Date(blame.timestamp * 1000).toLocaleString()}\n\n`);
    markdown.appendMarkdown(`[${blame.hash.slice(0, 8)}](${blame.hash.slice(0, 8)}) ${blame.summary}\n\n`);
    markdown.appendMarkdown(
      `[Open in Graph](command:gitloupe.openCommit?${encoded}) · ` +
        `[Copy hash](command:gitloupe.copyHash?${encoded}) · ` +
        `[File History](command:gitloupe.openFileHistory)\n`
    );
    return new vscode.Hover(markdown, document.lineAt(position.line).range);
  }

  async codeLensesFor(document: vscode.TextDocument): Promise<vscode.CodeLens[]> {
    if (!this.config('blame.codeLens', true)) return [];
    const repo = await this.repoFor(document);
    if (!repo) return [];
    let lines: BlameLine[];
    try {
      lines = await this.fileBlame(document, repo);
    } catch {
      return [];
    }
    const committed = lines.filter(entry => !entry.uncommitted);
    if (committed.length === 0) return [];
    const authors = new Set(committed.map(entry => entry.author));
    const mostRecent = committed.reduce(
      (best, entry) => (entry.timestamp > best.timestamp ? entry : best),
      committed[0]!
    );
    const lenses: vscode.CodeLens[] = [
      new vscode.CodeLens(new vscode.Range(0, 0, 0, 0), {
        command: 'gitloupe.openCommit',
        title: `$(git-commit) ${relativeTime(mostRecent.timestamp)} by ${mostRecent.author} · ${committed.length} commits, ${authors.size} authors`,
        arguments: [{ hash: mostRecent.hash, root: repo.root }]
      })
    ];
    if (this.config('blame.codeLensSymbols', true)) {
      const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
        'vscode.executeDocumentSymbolProvider',
        document.uri
      );
      if (symbols) {
        let count = 0;
        const visit = (list: vscode.DocumentSymbol[]): void => {
          for (const symbol of list) {
            if (count >= 250) return;
            const line = symbol.range.start.line + 1;
            const entry = lines.find(candidate => candidate.line === line);
            if (entry && !entry.uncommitted) {
              lenses.push(
                new vscode.CodeLens(symbol.selectionRange, {
                  command: 'gitloupe.openCommit',
                  title: `$(git-commit) ${entry.author}, ${relativeTime(entry.timestamp)}`,
                  arguments: [{ hash: entry.hash, root: repo.root }]
                })
              );
              count++;
            }
            if (symbol.children.length) visit(symbol.children);
          }
        };
        visit(symbols);
      }
    }
    return lenses;
  }

  dispose(): void {
    this.currentLineType.dispose();
    for (const type of this.heatTypes) type.dispose();
    this.statusBar.dispose();
    clearTimeout(this.debounce);
  }

  private async repoFor(document: vscode.TextDocument): Promise<RepoRef | null> {
    if (document.uri.scheme !== 'file') return null;
    const key = document.uri.toString();
    if (this.repoCache.has(key)) return this.repoCache.get(key) ?? null;
    try {
      const repo = await this.git.findRepository(document.uri.fsPath);
      const rel = path.relative(repo.root, document.uri.fsPath).replaceAll('\\', '/');
      const ref: RepoRef = { root: repo.root, rel };
      this.repoCache.set(key, ref);
      return ref;
    } catch {
      this.repoCache.set(key, null);
      return null;
    }
  }

  private async renderCurrentLine(editor: vscode.TextEditor, repo: RepoRef): Promise<void> {
    const line = editor.selection.active.line + 1;
    let blame: BlameLine | undefined;
    try {
      [blame] = await this.git.blame(repo.root, repo.rel, line, line);
    } catch {
      this.clearActive();
      return;
    }
    if (!blame) {
      this.clearActive();
      return;
    }
    const range = editor.document.lineAt(line - 1).range;
    if (blame.uncommitted) {
      this.statusBar.text = '$(git-commit) Uncommitted changes';
      this.statusBar.show();
      editor.setDecorations(this.currentLineType, [
        { range, renderOptions: { after: { contentText: '  (uncommitted)' } } }
      ]);
      return;
    }
    const text = formatBlame(this.config('blame.format', '${author}, ${date}'), blame);
    this.statusBar.text = `$(git-commit) ${blame.author}, ${relativeTime(blame.timestamp)}`;
    this.statusBar.show();
    editor.setDecorations(this.currentLineType, [{ range, renderOptions: { after: { contentText: '  ' + text } } }]);
  }

  private async renderHeatmap(editor: vscode.TextEditor, repo: RepoRef): Promise<void> {
    if (!this.config('blame.heatmap', false)) {
      for (const type of this.heatTypes) editor.setDecorations(type, []);
      return;
    }
    const limit = this.config('blame.heatmapMaxLines', 5000);
    if (editor.document.lineCount > limit) {
      for (const type of this.heatTypes) editor.setDecorations(type, []);
      return;
    }
    let lines: BlameLine[];
    try {
      lines = await this.fileBlame(editor.document, repo);
    } catch {
      for (const type of this.heatTypes) editor.setDecorations(type, []);
      return;
    }
    const buckets: vscode.Range[][] = this.heatTypes.map(() => []);
    for (const entry of lines) {
      if (entry.uncommitted) continue;
      const bucket = heatBucket(entry.timestamp);
      buckets[bucket]!.push(editor.document.lineAt(entry.line - 1).range);
    }
    this.heatTypes.forEach((type, index) => editor.setDecorations(type, buckets[index] ?? []));
  }

  private async fileBlame(document: vscode.TextDocument, repo: RepoRef): Promise<BlameLine[]> {
    const key = document.uri.toString();
    const cached = this.fileCache.get(key);
    if (cached && cached.version === document.version) return cached.lines;
    const lines = await this.git.blameFile(repo.root, repo.rel);
    this.fileCache.set(key, { version: document.version, lines });
    return lines;
  }

  private async resolveHash(args?: { hash?: string; root?: string }): Promise<{ root: string; hash: string } | undefined> {
    if (args?.hash && args.root) return { root: args.root, hash: args.hash };
    const editor = vscode.window.activeTextEditor;
    if (!editor) return undefined;
    const repo = await this.repoFor(editor.document);
    if (!repo) return undefined;
    const line = editor.selection.active.line + 1;
    try {
      const [blame] = await this.git.blame(repo.root, repo.rel, line, line);
      if (!blame || blame.uncommitted) return undefined;
      return { root: repo.root, hash: blame.hash };
    } catch {
      return undefined;
    }
  }

  private clearActive(): void {
    const editor = vscode.window.activeTextEditor;
    if (editor) {
      editor.setDecorations(this.currentLineType, []);
      for (const type of this.heatTypes) editor.setDecorations(type, []);
    }
    this.statusBar.hide();
  }

  private config<T>(section: string, fallback: T): T {
    return vscode.workspace.getConfiguration('gitloupe').get<T>(section, fallback);
  }
}

export class BlameHoverProvider implements vscode.HoverProvider {
  constructor(private readonly controller: BlameController) {}
  provideHover(document: vscode.TextDocument, position: vscode.Position): Promise<vscode.Hover | undefined> {
    return this.controller.hoverFor(document, position);
  }
}

export class BlameCodeLensProvider implements vscode.CodeLensProvider {
  constructor(private readonly controller: BlameController) {}
  provideCodeLenses(document: vscode.TextDocument): Promise<vscode.CodeLens[]> {
    return this.controller.codeLensesFor(document);
  }
}

function formatBlame(template: string, blame: BlameLine): string {
  return template
    .replaceAll('${author}', blame.author)
    .replaceAll('${email}', blame.email)
    .replaceAll('${date}', relativeTime(blame.timestamp))
    .replaceAll('${commit}', blame.hash.slice(0, 8))
    .replaceAll('${message}', blame.summary);
}

function relativeTime(timestamp: number): string {
  if (!timestamp) return 'just now';
  const seconds = Math.max(0, Date.now() / 1000 - timestamp);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 86400 * 30) return `${Math.floor(seconds / 86400)}d ago`;
  if (seconds < 86400 * 365) return `${Math.floor(seconds / (86400 * 30))}mo ago`;
  return `${Math.floor(seconds / (86400 * 365))}y ago`;
}

function heatBucket(timestamp: number): number {
  if (!timestamp) return 4;
  const days = (Date.now() / 1000 - timestamp) / 86400;
  if (days < 1) return 0;
  if (days < 7) return 1;
  if (days < 30) return 2;
  if (days < 365) return 3;
  return 4;
}
