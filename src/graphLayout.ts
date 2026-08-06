/**
 * Pure commit-graph lane layout used by the Graph Workbench webview.
 *
 * Kept free of any VS Code / DOM dependency so it can be unit-tested in Node
 * and injected verbatim into the webview's inline `<script>`.
 *
 * The `lane` for each commit is taken from `commit.column`, which the
 * extension fills from `git log --graph` (the exact column GitLens/Git use).
 * Using git's own column assignment makes the rendered graph pixel-identical
 * to GitLens for every topology, including octopus and criss-cross merges.
 * `before`/`after` are derived from those columns so every parent edge is
 * drawn and merge parents curve to their real lane.
 *
 * If `column` is missing on any commit we fall back to a self-contained lane
 * allocator so the graph still renders without git's help.
 */

export interface GraphCommit {
  hash: string;
  parents: string[];
  column?: number;
}

export interface GraphState {
  lane: number;
  before: string[];
  after: string[];
  parents: string[];
}

export function graphState(commits: GraphCommit[]): GraphState[] {
  const hasColumns = commits.every(commit => typeof commit.column === 'number');
  if (!hasColumns) return allocateLanes(commits);

  const columnOf = new Map(commits.map(commit => [commit.hash, commit.column as number]));
  const lanes: string[] = [];
  return commits.map(commit => {
    const before = lanes.slice();
    const lane = commit.column as number;
    const after = lanes.slice();
    // The commit is drawn at `lane`; clear its own column, then let every
    // parent continue down ITS column (git places each parent in its own lane,
    // curving from the commit when the parent is not directly below it).
    after[lane] = '';
    for (let i = 0; i < commit.parents.length; i++) {
      const parent = commit.parents[i] ?? '';
      if (!parent) continue;
      const parentColumn = columnOf.get(parent);
      if (parentColumn !== undefined) after[parentColumn] = parent;
      else after.push(parent);
    }
    while (after.length && !after[after.length - 1]) after.pop();
    return { lane, before, after, parents: commit.parents };
  });

  /** Self-contained fallback allocator (used only when git columns are absent).
   *  Defined inside `graphState` so its source is captured by
   *  `graphState.toString()` and ships inside the webview's inline script. */
  function allocateLanes(items: GraphCommit[]): GraphState[] {
    const lanes: string[] = [];
    return items.map(commit => {
      const before = lanes.slice();
      let lane = lanes.indexOf(commit.hash);
      if (lane < 0) {
        lane = lanes.findIndex(value => !value);
        if (lane < 0) lane = lanes.length;
      }
      lanes[lane] = commit.parents[0] || '';
      for (let i = 1; i < commit.parents.length; i++) {
        const parent = commit.parents[i] ?? '';
        let target = lanes.indexOf(parent);
        if (target < 0) {
          target = lanes.findIndex((value, index) => index > lane && !value);
          if (target < 0) target = lanes.length;
          lanes[target] = parent;
        }
      }
      while (lanes.length && !lanes[lanes.length - 1]) lanes.pop();
      return { lane, before, after: lanes.slice(), parents: commit.parents };
    });
  }
}
