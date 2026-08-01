import type { FileHistoryEntry } from './git.js';

export function visualFileHistoryHtml(file: string, entries: FileHistoryEntry[], nonce: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
  <style nonce="${nonce}">
    *{box-sizing:border-box}body{margin:0;padding:20px;color:var(--vscode-foreground);background:var(--vscode-editor-background);font:13px var(--vscode-font-family)}
    h1{font-size:22px;margin:0 0 4px;overflow-wrap:anywhere}.summary,.muted{color:var(--vscode-descriptionForeground)}
    .legend{display:flex;gap:14px;flex-wrap:wrap;margin:14px 0}.legend span{display:flex;gap:5px;align-items:center}.swatch{width:9px;height:9px;border-radius:50%}
    .controls{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:12px 0}.controls select,.controls input{color:var(--vscode-input-foreground);background:var(--vscode-input-background);border:1px solid var(--vscode-input-border,transparent);padding:5px 8px}.controls label{display:flex;gap:6px;align-items:center}
    .viewport{overflow:auto;border:1px solid var(--vscode-panel-border);margin:16px 0;background:color-mix(in srgb,var(--vscode-editor-background) 96%,white)}
    svg{display:block}.lane-label{fill:var(--vscode-descriptionForeground);font:11px var(--vscode-font-family)}.date-label{fill:var(--vscode-descriptionForeground);font:10px var(--vscode-font-family)}
    .lane{stroke:var(--vscode-panel-border);stroke-dasharray:2 3}.axis{stroke:var(--vscode-panel-border)}.commit{cursor:pointer;stroke:var(--vscode-editor-background);stroke-width:2}.commit:hover,.commit:focus{stroke:var(--vscode-focusBorder);stroke-width:3}
    .added{fill:var(--vscode-gitDecoration-addedResourceForeground)}.deleted{fill:var(--vscode-gitDecoration-deletedResourceForeground)}.revision.selected .commit{stroke:var(--vscode-focusBorder);stroke-width:4}.entry.selected{background:var(--vscode-list-activeSelectionBackground);color:var(--vscode-list-activeSelectionForeground)}
    .tooltip{min-height:48px;padding:10px;border:1px solid var(--vscode-panel-border);background:var(--vscode-sideBar-background)}.tooltip strong{display:block;margin-bottom:4px}.hash{font-family:var(--vscode-editor-font-family);color:var(--vscode-textLink-foreground)}
    .entry{display:grid;grid-template-columns:82px minmax(180px,1fr) 130px 95px;gap:10px;padding:8px;border-bottom:1px solid var(--vscode-panel-border);cursor:pointer}.entry:hover{background:var(--vscode-list-hoverBackground)}
    @media(max-width:650px){.entry{grid-template-columns:72px 1fr}.entry .optional{display:none}}
  </style>
</head>
<body>
  <h1 id="file"></h1>
  <div id="summary" class="summary"></div>
  <div class="controls">
    <label>Period <select id="period"><option value="0">All time</option><option value="30">30 days</option><option value="90">90 days</option><option value="365">1 year</option></select></label>
    <label>Author <select id="author"><option value="">All contributors</option></select></label>
    <label>Zoom <input id="zoom" type="range" min="1" max="4" step="0.25" value="1"></label>
  </div>
  <div id="legend" class="legend"></div>
  <div class="viewport"><svg id="history" role="img" aria-label="Visual file history timeline"></svg></div>
  <div id="tooltip" class="tooltip muted">Hover or focus a revision to inspect it. Click to open it in the Commit Graph.</div>
  <h2>Revisions</h2>
  <div id="entries"></div>
  <script nonce="${nonce}">
    const vscode=acquireVsCodeApi(),file=${safeJson(file)},entries=${safeJson(entries)};
    const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    const palette=['#4ec9b0','#569cd6','#dcdcaa','#c586c0','#ce9178','#9cdcfe','#b5cea8','#f48771'];
    document.getElementById('file').textContent=file;
    const allAuthors=[...new Set(entries.map(entry=>entry.author))],authorColor=new Map(allAuthors.map((author,index)=>[author,palette[index%palette.length]]));
    document.getElementById('author').innerHTML='<option value="">All contributors</option>'+allAuthors.map(author=>'<option value="'+esc(author)+'">'+esc(author)+'</option>').join('');
    let selectedHash;
    const inspect=entry=>{document.getElementById('tooltip').innerHTML='<strong>'+esc(entry.subject)+'</strong><span class="hash">'+esc(entry.hash.slice(0,12))+'</span> · '+esc(entry.author)+' · '+new Date(entry.timestamp*1000).toLocaleString()+' · <span style="color:var(--vscode-gitDecoration-addedResourceForeground)">+'+entry.added+'</span> <span style="color:var(--vscode-gitDecoration-deletedResourceForeground)">−'+entry.deleted+'</span>'};
    const select=entry=>{selectedHash=entry.hash;inspect(entry);document.querySelectorAll('[data-hash]').forEach(element=>{const selected=element.dataset.hash===selectedHash;element.classList.toggle('selected',selected);element.setAttribute('aria-selected',String(selected))})};
    function renderHistory(){const days=Number(document.getElementById('period').value),chosenAuthor=document.getElementById('author').value,cutoff=days?Date.now()/1000-days*86400:0,visible=entries.filter(entry=>(!cutoff||entry.timestamp>=cutoff)&&(!chosenAuthor||entry.author===chosenAuthor)),authors=[...new Set(visible.map(entry=>entry.author))],chronological=visible.slice().reverse(),left=118,right=24,top=30,laneHeight=58,chartBottom=Math.max(1,authors.length)*laneHeight+top,barHeight=82,zoom=Number(document.getElementById('zoom').value),width=Math.max(760,chronological.length*46*zoom+left+right),height=chartBottom+barHeight+42,max=Math.max(1,...visible.map(entry=>entry.added+entry.deleted)),totalAdded=visible.reduce((sum,entry)=>sum+entry.added,0),totalDeleted=visible.reduce((sum,entry)=>sum+entry.deleted,0);document.getElementById('summary').textContent=visible.length+' revisions · '+authors.length+' contributors · +'+totalAdded+' / −'+totalDeleted+' lines';document.getElementById('legend').innerHTML=authors.map(author=>'<span><i class="swatch" style="background:'+authorColor.get(author)+'"></i>'+esc(author)+'</span>').join('');const x=index=>left+(chronological.length<2?0:(width-left-right)*index/(chronological.length-1)),y=author=>top+authors.indexOf(author)*laneHeight+laneHeight/2;let svg=authors.map(author=>'<line class="lane" x1="'+left+'" y1="'+y(author)+'" x2="'+(width-right)+'" y2="'+y(author)+'"/><text class="lane-label" x="8" y="'+(y(author)+4)+'">'+esc(author)+'</text>').join('');svg+='<line class="axis" x1="'+left+'" y1="'+(chartBottom+4)+'" x2="'+(width-right)+'" y2="'+(chartBottom+4)+'"/>';chronological.forEach((entry,index)=>{const magnitude=entry.added+entry.deleted,r=5+Math.sqrt(magnitude/max)*10,cx=x(index),cy=y(entry.author),addH=entry.added/max*barHeight,delH=entry.deleted/max*barHeight;svg+='<g class="revision" data-index="'+index+'" data-hash="'+esc(entry.hash)+'" tabindex="0" role="button" aria-selected="'+(entry.hash===selectedHash)+'"><circle class="commit" cx="'+cx+'" cy="'+cy+'" r="'+r+'" fill="'+authorColor.get(entry.author)+'"><title>'+esc(entry.subject)+' · '+esc(entry.author)+' · +'+entry.added+' −'+entry.deleted+'</title></circle><rect class="added" x="'+(cx-5)+'" y="'+(chartBottom+barHeight-addH)+'" width="5" height="'+addH+'"/><rect class="deleted" x="'+cx+'" y="'+(chartBottom+barHeight-delH)+'" width="5" height="'+delH+'"/></g>';if(index===0||index===chronological.length-1||index%Math.max(1,Math.ceil(chronological.length/6))===0)svg+='<text class="date-label" x="'+cx+'" y="'+(height-10)+'" text-anchor="middle">'+new Date(entry.timestamp*1000).toLocaleDateString()+'</text>'});const chart=document.getElementById('history');chart.setAttribute('viewBox','0 0 '+width+' '+height);chart.setAttribute('width',width);chart.setAttribute('height',height);chart.innerHTML=svg;document.getElementById('entries').innerHTML=visible.map((entry,index)=>'<div class="entry '+(entry.hash===selectedHash?'selected':'')+'" data-entry="'+index+'" data-hash="'+esc(entry.hash)+'" tabindex="0" role="option" aria-selected="'+(entry.hash===selectedHash)+'"><span class="hash">'+esc(entry.hash.slice(0,8))+'</span><span>'+esc(entry.subject)+'</span><span class="optional muted">'+esc(entry.author)+'</span><span class="optional"><span style="color:var(--vscode-gitDecoration-addedResourceForeground)">+'+entry.added+'</span> <span style="color:var(--vscode-gitDecoration-deletedResourceForeground)">−'+entry.deleted+'</span></span></div>').join('')||'<p>No history found for this scope and filter.</p>';chart.querySelectorAll('.revision').forEach(group=>{const entry=chronological[Number(group.dataset.index)];group.addEventListener('mouseenter',()=>inspect(entry));group.addEventListener('focus',()=>select(entry));group.addEventListener('click',()=>select(entry));group.addEventListener('dblclick',()=>vscode.postMessage({type:'commit',hash:entry.hash}));group.addEventListener('keydown',event=>{if(event.key===' '){event.preventDefault();select(entry)}if(event.key==='Enter')vscode.postMessage({type:'commit',hash:entry.hash})})});document.querySelectorAll('[data-entry]').forEach(row=>{const entry=visible[Number(row.dataset.entry)];row.addEventListener('click',()=>select(entry));row.addEventListener('dblclick',()=>vscode.postMessage({type:'commit',hash:entry.hash}));row.addEventListener('keydown',event=>{if(event.key===' '){event.preventDefault();select(entry)}if(event.key==='Enter')vscode.postMessage({type:'commit',hash:entry.hash})})})}
    document.getElementById('period').addEventListener('change',renderHistory);document.getElementById('author').addEventListener('change',renderHistory);document.getElementById('zoom').addEventListener('input',renderHistory);renderHistory();
  </script>
</body>
</html>`;
}

function safeJson(value: unknown): string {
  return JSON.stringify(value).replaceAll('<', '\\u003c').replaceAll('>', '\\u003e').replaceAll('&', '\\u0026');
}
