import * as path from 'node:path';
import * as vscode from 'vscode';
import { CommitDetails, FileHistoryEntry, GitService, Repository, Worktree } from './git.js';

type GraphMessage =
  | { type: 'ready' }
  | { type: 'refresh' }
  | { type: 'repository'; root: string }
  | { type: 'commit'; hash: string }
  | { type: 'checkout'; ref: string }
  | { type: 'createBranch'; hash: string }
  | { type: 'cherryPick'; hash: string }
  | { type: 'diffFile'; hash: string; parent?: string; file: string }
  | { type: 'addWorktree' }
  | { type: 'openWorktree'; path: string }
  | { type: 'removeWorktree'; path: string };

export class GitContentProvider implements vscode.TextDocumentContentProvider {
  constructor(private readonly git: GitService) {}

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const query = new URLSearchParams(uri.query);
    const root = query.get('root');
    const hash = query.get('hash');
    const file = query.get('file');
    if (!root || !hash || !file) return '';
    try {
      return await this.git.fileAtRevision(root, hash, file);
    } catch {
      return '';
    }
  }
}

export class RepositoryViewProvider implements vscode.WebviewViewProvider {
  static readonly viewType = 'gitloupe.graphView';
  private view?: vscode.WebviewView;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly git: GitService,
    private readonly openGraph: () => Promise<void>
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [this.extensionUri] };
    view.webview.onDidReceiveMessage(message => {
      if (message?.type === 'openGraph') void this.openGraph();
      if (message?.type === 'refresh') void this.refresh();
    });
    void this.refresh();
  }

  async refresh(): Promise<void> {
    if (!this.view) return;
    const repositories = await this.git.discoverRepositories();
    const nonce = createNonce();
    this.view.webview.html = sidebarHtml(repositories, nonce);
  }
}

export class GraphPanel {
  private panel?: vscode.WebviewPanel;
  private repositories: Repository[] = [];
  private selected?: Repository;
  private disposables: vscode.Disposable[] = [];

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly git: GitService
  ) {}

  async show(preferredRoot?: string): Promise<void> {
    this.repositories = await this.git.discoverRepositories();
    this.selected = this.repositories.find(repo => repo.root === preferredRoot) ?? this.repositories[0];
    if (!this.selected) {
      void vscode.window.showInformationMessage('GitLoupe: Open a folder containing a Git repository first.');
      return;
    }

    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.One);
      await this.load();
      return;
    }

    this.panel = vscode.window.createWebviewPanel(
      'gitloupe.graph',
      `GitLoupe — ${this.selected.name}`,
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [this.extensionUri]
      }
    );
    this.panel.iconPath = vscode.Uri.joinPath(this.extensionUri, 'resources', 'gitloupe.svg');
    this.panel.webview.html = graphHtml(createNonce());
    this.disposables.push(
      this.panel.webview.onDidReceiveMessage(message => void this.handleMessage(message as GraphMessage)),
      this.panel.onDidDispose(() => {
        this.panel = undefined;
        for (const disposable of this.disposables.splice(0)) disposable.dispose();
      })
    );
  }

  async refresh(): Promise<void> {
    if (this.panel) await this.load();
  }

  private async handleMessage(message: GraphMessage): Promise<void> {
    try {
      switch (message.type) {
        case 'ready':
        case 'refresh':
          await this.load();
          break;
        case 'repository': {
          const selected = this.repositories.find(repo => repo.root === message.root);
          if (selected) {
            this.selected = selected;
            await this.load();
          }
          break;
        }
        case 'commit':
          await this.sendCommit(message.hash);
          break;
        case 'checkout':
          await this.checkout(message.ref);
          break;
        case 'createBranch':
          await this.createBranch(message.hash);
          break;
        case 'cherryPick':
          await this.cherryPick(message.hash);
          break;
        case 'diffFile':
          await this.diffFile(message.hash, message.parent, message.file);
          break;
        case 'addWorktree':
          await this.addWorktree();
          break;
        case 'openWorktree':
          await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(message.path), true);
          break;
        case 'removeWorktree':
          await this.removeWorktree(message.path);
          break;
      }
    } catch (error) {
      await this.send({ type: 'error', message: errorMessage(error) });
    }
  }

  private async load(): Promise<void> {
    const repo = this.selected;
    if (!repo || !this.panel) return;
    await this.send({ type: 'loading', value: true });
    try {
      const limit = vscode.workspace.getConfiguration('gitloupe').get('graph.maxCommits', 500);
      const [commits, worktrees, branch] = await Promise.all([
        this.git.graph(repo.root, limit),
        this.git.listWorktrees(repo.root),
        this.git.currentBranch(repo.root)
      ]);
      repo.branch = branch;
      this.panel.title = `GitLoupe — ${repo.name}`;
      await this.send({
        type: 'graph',
        repositories: this.repositories,
        repository: repo,
        commits,
        worktrees
      });
    } finally {
      await this.send({ type: 'loading', value: false });
    }
  }

  private async sendCommit(hash: string): Promise<void> {
    if (!this.selected) return;
    const details = await this.git.commitDetails(this.selected.root, hash);
    await this.send({ type: 'commit', commit: details });
  }

  private async checkout(ref: string): Promise<void> {
    if (!this.selected) return;
    const answer = await vscode.window.showWarningMessage(
      `Checkout "${ref}" in ${this.selected.name}?`,
      { modal: true },
      'Checkout'
    );
    if (answer !== 'Checkout') return;
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Checking out ${ref}…` },
      () => this.git.checkout(this.selected!.root, ref)
    );
    await this.load();
  }

  private async createBranch(hash: string): Promise<void> {
    if (!this.selected) return;
    const name = await vscode.window.showInputBox({
      title: `Create branch at ${hash.slice(0, 8)}`,
      prompt: 'Branch name',
      validateInput: value => value.trim() ? undefined : 'Enter a branch name.'
    });
    if (!name) return;
    await this.git.createBranch(this.selected.root, name.trim(), hash);
    await this.load();
  }

  private async cherryPick(hash: string): Promise<void> {
    if (!this.selected) return;
    const answer = await vscode.window.showWarningMessage(
      `Cherry-pick ${hash.slice(0, 8)} onto ${this.selected.branch}?`,
      { modal: true, detail: 'This changes the working tree and current branch.' },
      'Cherry-pick'
    );
    if (answer !== 'Cherry-pick') return;
    await this.git.cherryPick(this.selected.root, hash);
    await this.load();
  }

  private async diffFile(hash: string, parent: string | undefined, file: string): Promise<void> {
    if (!this.selected) return;
    const leftHash = parent ?? `${hash}^`;
    const makeUri = (revision: string) => vscode.Uri.from({
      scheme: 'gitloupe',
      path: `/${path.basename(file)}`,
      query: new URLSearchParams({ root: this.selected!.root, hash: revision, file }).toString()
    });
    await vscode.commands.executeCommand(
      'vscode.diff',
      makeUri(leftHash),
      makeUri(hash),
      `${file} (${leftHash.slice(0, 8)} ↔ ${hash.slice(0, 8)})`
    );
  }

  private async addWorktree(): Promise<void> {
    if (!this.selected) return;
    const parent = await vscode.window.showOpenDialog({
      title: 'Choose the parent folder for the new worktree',
      canSelectFolders: true,
      canSelectFiles: false,
      canSelectMany: false
    });
    if (!parent?.[0]) return;
    const folderName = await vscode.window.showInputBox({
      title: 'New worktree folder',
      value: `${this.selected.name}-worktree`,
      validateInput: value => value.trim() ? undefined : 'Enter a folder name.'
    });
    if (!folderName) return;
    const refs = (await this.git.graph(this.selected.root, 100))
      .flatMap(commit => commit.refs)
      .map(cleanRef)
      .filter((ref, index, all) => ref && all.indexOf(ref) === index);
    const selectedRef = await vscode.window.showQuickPick(
      [{ label: 'HEAD', description: 'Current revision' }, ...refs.map(ref => ({ label: ref }))],
      { title: 'Revision for the new worktree' }
    );
    if (!selectedRef) return;
    await this.git.addWorktree(this.selected.root, path.join(parent[0].fsPath, folderName), selectedRef.label);
    await this.load();
  }

  private async removeWorktree(worktreePath: string): Promise<void> {
    if (!this.selected) return;
    const answer = await vscode.window.showWarningMessage(
      `Remove worktree "${worktreePath}"?`,
      { modal: true, detail: 'Git refuses removal when the worktree has uncommitted changes.' },
      'Remove'
    );
    if (answer !== 'Remove') return;
    await this.git.removeWorktree(this.selected.root, worktreePath);
    await this.load();
  }

  private async send(message: unknown): Promise<void> {
    await this.panel?.webview.postMessage(message);
  }
}

export async function showFileHistory(
  extensionUri: vscode.Uri,
  git: GitService,
  resource?: vscode.Uri
): Promise<void> {
  const uri = resource ?? vscode.window.activeTextEditor?.document.uri;
  if (!uri || uri.scheme !== 'file') {
    void vscode.window.showInformationMessage('GitLoupe: Open a tracked file first.');
    return;
  }
  try {
    const repo = await git.findRepository(uri.fsPath);
    const entries = await git.fileHistory(repo.root, uri.fsPath);
    const relative = path.relative(repo.root, uri.fsPath).replaceAll('\\', '/');
    const panel = vscode.window.createWebviewPanel(
      'gitloupe.fileHistory',
      `History — ${path.basename(uri.fsPath)}`,
      vscode.ViewColumn.One,
      { enableScripts: true, localResourceRoots: [extensionUri] }
    );
    panel.iconPath = vscode.Uri.joinPath(extensionUri, 'resources', 'gitloupe.svg');
    panel.webview.html = fileHistoryHtml(relative, entries, createNonce());
  } catch (error) {
    void vscode.window.showErrorMessage(`GitLoupe: ${errorMessage(error)}`);
  }
}

function graphHtml(nonce: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
  <style nonce="${nonce}">${commonCss()}
    body { overflow: hidden; }
    header { height: 48px; display: flex; align-items: center; gap: 10px; padding: 0 14px; border-bottom: 1px solid var(--vscode-panel-border); }
    header select { min-width: 160px; }
    #search { flex: 1; max-width: 520px; }
    .layout { display: grid; grid-template-columns: minmax(440px, 1fr) minmax(280px, 390px); height: calc(100vh - 49px); }
    .list { overflow: auto; }
    .row { height: 34px; display: grid; grid-template-columns: 112px minmax(180px,1fr) 130px 100px; align-items: center; border-bottom: 1px solid color-mix(in srgb, var(--vscode-panel-border) 55%, transparent); cursor: pointer; }
    .row:hover, .row.selected { background: var(--vscode-list-hoverBackground); }
    .graph { width: 112px; height: 34px; overflow: visible; }
    .subject { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; padding-right: 8px; }
    .author,.date { color: var(--vscode-descriptionForeground); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .refs { display: inline-flex; gap: 4px; margin-right: 7px; vertical-align: middle; }
    .ref { border: 1px solid var(--vscode-badge-background); border-radius: 9px; padding: 0 6px; color: var(--vscode-badge-foreground); background: var(--vscode-badge-background); font-size: 10px; }
    aside { border-left: 1px solid var(--vscode-panel-border); overflow: auto; padding: 14px; }
    .empty { display: grid; place-items: center; min-height: 180px; color: var(--vscode-descriptionForeground); text-align: center; }
    .hash { font-family: var(--vscode-editor-font-family); color: var(--vscode-textLink-foreground); }
    .body { white-space: pre-wrap; color: var(--vscode-descriptionForeground); }
    .file { display: flex; gap: 8px; align-items: center; width: 100%; text-align: left; background: transparent; border: 0; border-bottom: 1px solid var(--vscode-panel-border); padding: 7px 2px; color: inherit; }
    .file:hover { background: var(--vscode-list-hoverBackground); }
    .status { width: 20px; font-weight: 700; color: var(--vscode-gitDecoration-modifiedResourceForeground); }
    .actions { display: flex; flex-wrap: wrap; gap: 6px; margin: 12px 0; }
    details { margin-top: 18px; }
    summary { cursor: pointer; font-weight: 600; }
    .worktree { margin: 8px 0; padding: 8px; background: var(--vscode-sideBar-background); }
    .worktree-path { overflow-wrap: anywhere; color: var(--vscode-descriptionForeground); font-size: 11px; }
    #loading { width: 100%; height: 2px; position: fixed; top: 48px; z-index: 2; background: var(--vscode-progressBar-background); animation: pulse 1s infinite alternate; display: none; }
    @keyframes pulse { from { opacity:.25 } to { opacity:1 } }
    @media(max-width:760px) { .layout { grid-template-columns:1fr } aside { display:none } .row { grid-template-columns:100px minmax(160px,1fr) 100px } .date{display:none} }
  </style>
</head>
<body>
  <header>
    <select id="repo" aria-label="Repository"></select>
    <input id="search" type="search" placeholder="Search commits, authors, hashes, or refs">
    <button id="refresh" title="Refresh">↻</button>
    <span id="count"></span>
  </header>
  <div id="loading"></div>
  <main class="layout">
    <section id="list" class="list"><div class="empty">Loading commit graph…</div></section>
    <aside id="details"><div class="empty">Select a commit to inspect it.</div></aside>
  </main>
  <script nonce="${nonce}">${graphScript()}</script>
</body>
</html>`;
}

function graphScript(): string {
  return String.raw`
    const vscode = acquireVsCodeApi();
    const $ = id => document.getElementById(id);
    let model = { commits: [], worktrees: [], repository: null };
    let selectedHash = '';
    const colors = ['#4ec9b0','#569cd6','#dcdcaa','#c586c0','#ce9178','#9cdcfe','#b5cea8'];
    const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    const relative = timestamp => {
      const seconds = Math.max(0, Date.now()/1000 - timestamp);
      if (seconds < 60) return 'now';
      if (seconds < 3600) return Math.floor(seconds/60) + 'm ago';
      if (seconds < 86400) return Math.floor(seconds/3600) + 'h ago';
      if (seconds < 86400*30) return Math.floor(seconds/86400) + 'd ago';
      return new Date(timestamp*1000).toLocaleDateString();
    };
    function cleanRef(ref) {
      return ref.replace(/^HEAD -> /,'').replace(/^tag: /,'').replace(/^origin\//,'');
    }
    function graphState(commits) {
      const lanes = [];
      return commits.map(commit => {
        let lane = lanes.indexOf(commit.hash);
        if (lane < 0) {
          lane = lanes.findIndex(value => !value);
          if (lane < 0) lane = lanes.length;
        }
        lanes[lane] = commit.parents[0] || '';
        for (let i=1; i<commit.parents.length; i++) {
          let target = lanes.indexOf(commit.parents[i]);
          if (target < 0) {
            target = lanes.findIndex((value,index) => index > lane && !value);
            if (target < 0) target = lanes.length;
            lanes[target] = commit.parents[i];
          }
        }
        while (lanes.length && !lanes[lanes.length-1]) lanes.pop();
        return { lane, active: lanes.slice(), parents: commit.parents };
      });
    }
    function graphSvg(state) {
      const x = lane => 12 + lane*16;
      let svg = '';
      state.active.forEach((hash,lane) => {
        if (hash) svg += '<path d="M'+x(lane)+' 0V34" stroke="'+colors[lane%colors.length]+'" />';
      });
      state.parents.slice(1).forEach((parent,index) => {
        const target = state.active.indexOf(parent);
        if (target >= 0) svg += '<path d="M'+x(state.lane)+' 17 C'+x(state.lane)+' 26 '+x(target)+' 8 '+x(target)+' 34" stroke="'+colors[target%colors.length]+'" />';
      });
      svg += '<circle cx="'+x(state.lane)+'" cy="17" r="4.5" fill="'+colors[state.lane%colors.length]+'" stroke="var(--vscode-editor-background)" stroke-width="2"/>';
      return '<svg class="graph" viewBox="0 0 112 34" preserveAspectRatio="xMinYMid meet" fill="none" stroke-width="2">'+svg+'</svg>';
    }
    function render() {
      const query = $('search').value.trim().toLowerCase();
      const states = graphState(model.commits);
      const rows = model.commits.map((commit,index) => ({commit,index})).filter(({commit}) => {
        if (!query) return true;
        return [commit.hash,commit.subject,commit.author,commit.email,...commit.refs].join(' ').toLowerCase().includes(query);
      });
      $('count').textContent = rows.length + ' commits';
      $('list').innerHTML = rows.length ? rows.map(({commit,index}) => {
        const refs = commit.refs.slice(0,3).map(ref => '<span class="ref">'+esc(ref)+'</span>').join('');
        return '<div class="row '+(commit.hash===selectedHash?'selected':'')+'" data-hash="'+commit.hash+'">'+graphSvg(states[index])+
          '<div class="subject"><span class="refs">'+refs+'</span>'+esc(commit.subject)+'</div>'+
          '<div class="author" title="'+esc(commit.email)+'">'+esc(commit.author)+'</div>'+
          '<div class="date">'+relative(commit.timestamp)+'</div></div>';
      }).join('') : '<div class="empty">No matching commits.</div>';
      $('list').querySelectorAll('.row').forEach(row => row.addEventListener('click', () => {
        selectedHash = row.dataset.hash;
        vscode.postMessage({type:'commit',hash:selectedHash});
        render();
      }));
    }
    function renderCommit(commit) {
      const files = commit.files.map(file => '<button class="file" data-file="'+esc(file.path)+'"><span class="status">'+esc(file.status[0])+'</span><span>'+esc(file.oldPath ? file.oldPath+' → '+file.path : file.path)+'</span></button>').join('');
      const refs = commit.refs.map(ref => '<span class="ref">'+esc(ref)+'</span>').join(' ');
      const checkoutRef = commit.refs.map(cleanRef).find(ref => ref && !ref.includes(' -> '));
      $('details').innerHTML = '<div>'+refs+'</div><h2>'+esc(commit.subject)+'</h2>'+
        '<div><span class="hash">'+esc(commit.hash.slice(0,12))+'</span> · '+esc(commit.author)+' · '+new Date(commit.timestamp*1000).toLocaleString()+'</div>'+
        (commit.body?'<p class="body">'+esc(commit.body)+'</p>':'')+
        '<div class="actions">'+(checkoutRef?'<button id="checkout">Checkout '+esc(checkoutRef)+'</button>':'')+'<button id="branch">New branch</button><button id="pick">Cherry-pick</button></div>'+
        '<h3>Changed files ('+commit.files.length+')</h3><div>'+files+'</div>'+
        renderWorktrees();
      $('checkout')?.addEventListener('click',()=>vscode.postMessage({type:'checkout',ref:checkoutRef}));
      $('branch').addEventListener('click',()=>vscode.postMessage({type:'createBranch',hash:commit.hash}));
      $('pick').addEventListener('click',()=>vscode.postMessage({type:'cherryPick',hash:commit.hash}));
      $('details').querySelectorAll('.file').forEach(button => button.addEventListener('click',()=>vscode.postMessage({
        type:'diffFile',hash:commit.hash,parent:commit.parents[0],file:button.dataset.file
      })));
      wireWorktrees();
    }
    function renderWorktrees() {
      return '<details open><summary>Worktrees ('+model.worktrees.length+')</summary>'+
        '<div class="actions"><button id="add-worktree">Add worktree</button></div>'+
        model.worktrees.map((tree,index) => '<div class="worktree"><strong>'+esc(tree.branch || '(detached)')+'</strong>'+
          '<div class="worktree-path">'+esc(tree.path)+'</div><div class="actions"><button data-open="'+index+'">Open</button>'+
          (index?'<button data-remove="'+index+'">Remove</button>':'')+'</div></div>').join('')+'</details>';
    }
    function wireWorktrees() {
      $('add-worktree')?.addEventListener('click',()=>vscode.postMessage({type:'addWorktree'}));
      document.querySelectorAll('[data-open]').forEach(button=>button.addEventListener('click',()=>vscode.postMessage({type:'openWorktree',path:model.worktrees[Number(button.dataset.open)].path})));
      document.querySelectorAll('[data-remove]').forEach(button=>button.addEventListener('click',()=>vscode.postMessage({type:'removeWorktree',path:model.worktrees[Number(button.dataset.remove)].path})));
    }
    $('search').addEventListener('input',render);
    $('refresh').addEventListener('click',()=>vscode.postMessage({type:'refresh'}));
    $('repo').addEventListener('change',event=>vscode.postMessage({type:'repository',root:event.target.value}));
    window.addEventListener('message',event => {
      const message = event.data;
      if (message.type === 'loading') $('loading').style.display = message.value ? 'block' : 'none';
      if (message.type === 'error') {
        $('loading').style.display = 'none';
        $('details').innerHTML = '<div class="empty">'+esc(message.message)+'</div>';
      }
      if (message.type === 'graph') {
        model = message;
        $('repo').innerHTML = message.repositories.map(repo=>'<option value="'+esc(repo.root)+'" '+(repo.root===message.repository.root?'selected':'')+'>'+esc(repo.name)+' · '+esc(repo.branch)+'</option>').join('');
        selectedHash = '';
        $('details').innerHTML = '<div class="empty"><div><strong>'+esc(message.repository.branch)+'</strong><br>Select a commit to inspect it.<br><br>'+renderWorktrees()+'</div></div>';
        wireWorktrees();
        render();
      }
      if (message.type === 'commit') renderCommit(message.commit);
    });
    vscode.postMessage({type:'ready'});
  `;
}

function fileHistoryHtml(file: string, entries: FileHistoryEntry[], nonce: string): string {
  const data = safeJson(entries);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
  <style nonce="${nonce}">${commonCss()}
    body { padding: 20px; max-width: 1100px; margin: auto; }
    .summary { color: var(--vscode-descriptionForeground); }
    .chart { display: grid; grid-template-columns: repeat(auto-fit,minmax(8px,1fr)); height: 180px; align-items: end; gap: 2px; margin: 24px 0; border-bottom: 1px solid var(--vscode-panel-border); }
    .bar { min-width: 3px; display: flex; flex-direction: column; justify-content: end; cursor: pointer; height: 100%; }
    .added { background: var(--vscode-gitDecoration-addedResourceForeground); min-height: 1px; }
    .deleted { background: var(--vscode-gitDecoration-deletedResourceForeground); min-height: 1px; }
    .entry { display:grid; grid-template-columns: 90px minmax(200px,1fr) 140px 100px; gap: 12px; padding: 8px; border-bottom:1px solid var(--vscode-panel-border); }
    .hash { font-family:var(--vscode-editor-font-family); color:var(--vscode-textLink-foreground) }
    .muted { color:var(--vscode-descriptionForeground); white-space:nowrap; overflow:hidden; text-overflow:ellipsis }
    @media(max-width:650px){.entry{grid-template-columns:80px 1fr}.entry .muted{display:none}}
  </style>
</head>
<body>
  <h1>${escapeHtml(file)}</h1>
  <div id="summary" class="summary"></div>
  <div id="chart" class="chart"></div>
  <div id="entries"></div>
  <script nonce="${nonce}">
    const entries=${data};
    const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    const max=Math.max(1,...entries.map(entry=>entry.added+entry.deleted));
    const totalAdded=entries.reduce((sum,entry)=>sum+entry.added,0);
    const totalDeleted=entries.reduce((sum,entry)=>sum+entry.deleted,0);
    document.getElementById('summary').textContent=entries.length+' revisions · +'+totalAdded+' / −'+totalDeleted+' lines';
    document.getElementById('chart').innerHTML=entries.slice().reverse().map(entry=>{
      const added=entry.added/max*100, deleted=entry.deleted/max*100;
      return '<div class="bar" title="'+esc(entry.subject)+' · +'+entry.added+' −'+entry.deleted+'"><div class="added" style="height:'+added+'%"></div><div class="deleted" style="height:'+deleted+'%"></div></div>';
    }).join('');
    document.getElementById('entries').innerHTML=entries.map(entry=>'<div class="entry"><span class="hash">'+esc(entry.hash.slice(0,8))+'</span><span>'+esc(entry.subject)+'</span><span class="muted">'+esc(entry.author)+'</span><span class="muted">+'+entry.added+' −'+entry.deleted+'</span></div>').join('') || '<p>No history found. The file may be untracked.</p>';
  </script>
</body>
</html>`;
}

function sidebarHtml(repositories: Repository[], nonce: string): string {
  const rows = repositories.length
    ? repositories.map(repo => `<div class="repo"><strong>${escapeHtml(repo.name)}</strong><span>${escapeHtml(repo.branch)}</span></div>`).join('')
    : '<p class="muted">No Git repositories found in this workspace.</p>';
  return `<!doctype html><html><head>
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
  <style nonce="${nonce}">${commonCss()}body{padding:10px}.repo{display:flex;justify-content:space-between;padding:8px 2px;border-bottom:1px solid var(--vscode-panel-border)}.repo span,.muted{color:var(--vscode-descriptionForeground)}button{width:100%;margin-top:10px}</style>
  </head><body>${rows}<button id="open">Open Commit Graph</button><button id="refresh" class="secondary">Refresh</button>
  <script nonce="${nonce}">const vscode=acquireVsCodeApi();document.getElementById('open').addEventListener('click',()=>vscode.postMessage({type:'openGraph'}));document.getElementById('refresh').addEventListener('click',()=>vscode.postMessage({type:'refresh'}));</script>
  </body></html>`;
}

function commonCss(): string {
  return `
    * { box-sizing: border-box; }
    body { margin: 0; color: var(--vscode-foreground); background: var(--vscode-editor-background); font: 13px var(--vscode-font-family); }
    button, input, select { color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border,transparent); padding: 5px 8px; border-radius: 2px; font: inherit; }
    button { color: var(--vscode-button-foreground); background: var(--vscode-button-background); cursor: pointer; }
    button:hover { background: var(--vscode-button-hoverBackground); }
    button.secondary { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
    input:focus,select:focus,button:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
    h1 { font-size: 22px; } h2 { font-size: 17px; overflow-wrap:anywhere; } h3 { font-size: 13px; }
  `;
}

function cleanRef(ref: string): string {
  return ref.replace(/^HEAD -> /, '').replace(/^tag: /, '').replace(/^origin\//, '');
}

function createNonce(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from({ length: 32 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join('');
}

function safeJson(value: unknown): string {
  return JSON.stringify(value).replaceAll('<', '\\u003c').replaceAll('>', '\\u003e').replaceAll('&', '\\u0026');
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, character => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[character] ?? character);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
