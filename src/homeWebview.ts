export interface HomeRepository {
  name: string;
  root: string;
  branch: string;
}

export interface HomeStash {
  ref: string;
  message: string;
  timestamp: number;
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

function relativeTime(timestamp: number): string {
  if (!timestamp) return 'unknown';
  const seconds = Math.max(0, Date.now() / 1000 - timestamp);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 86400 * 30) return `${Math.floor(seconds / 86400)}d ago`;
  return new Date(timestamp * 1000).toLocaleDateString();
}

export function homeViewHtml(repositories: HomeRepository[], stashes: Map<string, HomeStash[]>, nonce: string): string {
  const repositoryRows = repositories.length
    ? repositories.map(repo => `<div class="repository" title="${escapeHtml(repo.root)}"><span class="repository-icon" aria-hidden="true">⑂</span><span class="repository-copy"><strong>${escapeHtml(repo.name)}</strong><span>${escapeHtml(repo.branch || 'detached HEAD')}</span></span></div>`).join('')
    : '<p class="empty">No Git repositories found in this workspace.</p>';
  const stashEntries = repositories.flatMap(repo =>
    (stashes.get(repo.root) ?? []).map(stash => ({ ...stash, root: repo.root, repoName: repo.name }))
  );
  const stashRows = stashEntries.length
    ? stashEntries.map(stash => `<article class="stash"><div class="stash-title" title="${escapeHtml(stash.message)}">${escapeHtml(stash.message)}</div><div class="meta">${escapeHtml(stash.ref)} · ${escapeHtml(stash.repoName)} · ${relativeTime(stash.timestamp)}</div><div class="stash-actions"><button data-action="stashView" data-root="${escapeHtml(stash.root)}" data-ref="${escapeHtml(stash.ref)}">View</button><button class="secondary" data-action="stashPop" data-root="${escapeHtml(stash.root)}" data-ref="${escapeHtml(stash.ref)}">Pop</button><button class="secondary" data-action="stashApply" data-root="${escapeHtml(stash.root)}" data-ref="${escapeHtml(stash.ref)}">Apply</button><button class="link danger" data-action="stashDrop" data-root="${escapeHtml(stash.root)}" data-ref="${escapeHtml(stash.ref)}">Drop</button></div></article>`).join('')
    : '<p class="empty">No stashes in this workspace.</p>';
  return `<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';"><style nonce="${nonce}">
    *{box-sizing:border-box} body{margin:0;padding:8px 12px 12px;color:var(--vscode-foreground);background:var(--vscode-sideBar-background);font:13px var(--vscode-font-family)} button{border:0;border-radius:2px;padding:6px 10px;color:var(--vscode-button-foreground);background:var(--vscode-button-background);font:inherit;cursor:pointer}button:hover{background:var(--vscode-button-hoverBackground)}button:focus-visible{outline:1px solid var(--vscode-focusBorder);outline-offset:1px}.secondary{color:var(--vscode-button-secondaryForeground);background:var(--vscode-button-secondaryBackground)}.secondary:hover{background:var(--vscode-button-secondaryHoverBackground)}.link{padding:3px 4px;color:var(--vscode-textLink-foreground);background:transparent}.link:hover{background:var(--vscode-toolbar-hoverBackground);text-decoration:underline}.danger:hover{color:var(--vscode-errorForeground)}.repository{display:flex;gap:8px;align-items:center;padding:7px 4px;border-bottom:1px solid var(--vscode-tree-tableColumnsBorder,var(--vscode-panel-border))}.repository-icon{color:var(--vscode-descriptionForeground);font-size:16px}.repository-copy{display:flex;flex:1;min-width:0;flex-direction:column;line-height:1.35}.repository-copy strong,.repository-copy span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.repository-copy span,.meta,.empty{color:var(--vscode-descriptionForeground);font-size:11px}.section-label{margin:15px 0 6px;color:var(--vscode-descriptionForeground);font-size:11px;font-weight:700;text-transform:uppercase}.primary{width:100%;margin:3px 0 6px}.actions{display:grid;grid-template-columns:1fr 1fr;gap:5px}.actions button{min-width:0;padding-inline:5px}.stash{padding:8px 4px 10px;border-bottom:1px solid var(--vscode-tree-tableColumnsBorder,var(--vscode-panel-border))}.stash-title{overflow:hidden;font-weight:600;line-height:1.35;text-overflow:ellipsis;white-space:nowrap}.meta{margin:3px 0 7px}.stash-actions{display:flex;flex-wrap:wrap;gap:4px}.stash-actions button{padding:3px 8px;font-size:11px}.empty{margin:8px 4px;line-height:1.4}@media(max-width:210px){.actions{grid-template-columns:1fr}}
  </style></head><body><div class="section-label">Repositories (${repositories.length})</div>${repositoryRows}<div class="section-label">Quick Actions</div><button id="open-graph" class="primary">Open Commit Graph</button><div class="actions"><button id="repository-history" class="secondary">Visual History</button><button id="file-history" class="secondary">File History</button><button id="launchpad" class="secondary">Launchpad</button><button id="refresh" class="secondary">Refresh</button></div><div class="section-label">Stashes (${stashEntries.length})</div>${stashRows}<script nonce="${nonce}">const vscode=acquireVsCodeApi();document.getElementById('open-graph').addEventListener('click',()=>vscode.postMessage({type:'openGraph'}));document.getElementById('repository-history').addEventListener('click',()=>vscode.postMessage({type:'openRepositoryHistory'}));document.getElementById('file-history').addEventListener('click',()=>vscode.postMessage({type:'openFileHistory'}));document.getElementById('launchpad').addEventListener('click',()=>vscode.postMessage({type:'openLaunchpad'}));document.getElementById('refresh').addEventListener('click',()=>vscode.postMessage({type:'refresh'}));document.querySelectorAll('[data-action]').forEach(button=>button.addEventListener('click',()=>vscode.postMessage({type:button.dataset.action,root:button.dataset.root,ref:button.dataset.ref})));</script></body></html>`;
}
