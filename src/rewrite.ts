export type RebaseTodoAction = 'reword' | 'squash' | 'fixup' | 'drop';
export type RebaseReorderAction = 'moveParent' | 'moveHead';

export function rewriteRebaseTodo(todo: string, action: RebaseTodoAction, target: string): string {
  return rewriteRebaseTodoMany(todo, action, [target]);
}

export function rewriteRebaseTodoMany(todo: string, action: RebaseTodoAction, targets: string[]): string {
  const lines = todo.split(/\r?\n/);
  const changed = new Set<string>();
  for (let index = 0; index < lines.length; index++) {
    const match = /^(pick)\s+([0-9a-f]+)\s+/.exec(lines[index] ?? '');
    if (!match) continue;
    const target = targets.find(value => value.startsWith(match[2]!) || match[2]!.startsWith(value));
    if (!target) continue;
    lines[index] = lines[index]!.replace(/^pick/, action);
    changed.add(target);
  }
  if (changed.size !== targets.length) throw new Error('A target commit was not present in the rebase plan.');
  return lines.join('\n');
}

export function reorderRebaseTodo(todo: string, action: RebaseReorderAction, target: string): string {
  const lines = todo.split(/\r?\n/);
  const index = lines.findIndex(line => {
    const hash = /^pick\s+([0-9a-f]+)\s+/.exec(line)?.[1];
    return Boolean(hash && (target.startsWith(hash) || hash.startsWith(target)));
  });
  if (index < 0) throw new Error('Target commit was not present in the rebase plan.');
  const destination = action === 'moveParent' ? index - 1 : index + 1;
  if (destination < 0 || destination >= lines.length || !/^pick\s/.test(lines[destination] ?? '')) {
    throw new Error('The commit cannot move farther in that direction.');
  }
  [lines[index], lines[destination]] = [lines[destination]!, lines[index]!];
  return lines.join('\n');
}

/** Moves a commit directly after another commit in Git's oldest-to-newest todo order. */
export function moveRebaseTodoAfter(todo: string, target: string, after: string): string {
  const lines = todo.split(/\r?\n/);
  let source = -1;
  let destination = -1;
  for (let index = 0; index < lines.length; index++) {
    const candidate = /^pick\s+([0-9a-f]+)\s+/.exec(lines[index] ?? '')?.[1];
    if (!candidate) continue;
    if (target.startsWith(candidate) || candidate.startsWith(target)) source = index;
    if (after.startsWith(candidate) || candidate.startsWith(after)) destination = index;
  }
  if (source < 0 || destination < 0) throw new Error('A target commit was not present in the rebase plan.');
  if (source === destination) throw new Error('A commit cannot be moved onto itself.');
  const [line] = lines.splice(source, 1);
  const adjustedDestination = source < destination ? destination - 1 : destination;
  lines.splice(adjustedDestination + 1, 0, line!);
  return lines.join('\n');
}

export const sequenceEditorSource = String.raw`
const fs = require('node:fs');
const rewriteRebaseTodoMany = ${rewriteRebaseTodoMany.toString()};
const reorderRebaseTodo = ${reorderRebaseTodo.toString()};
const moveRebaseTodoAfter = ${moveRebaseTodoAfter.toString()};
const file = process.argv[2];
const action = process.env.GITLOUPE_REBASE_ACTION;
const targets = JSON.parse(process.env.GITLOUPE_REBASE_TARGETS || '[]');
const todo = fs.readFileSync(file, 'utf8');
fs.writeFileSync(file, action === 'moveParent' || action === 'moveHead'
  ? reorderRebaseTodo(todo, action, targets[0])
  : action === 'move'
    ? moveRebaseTodoAfter(todo, targets[0], process.env.GITLOUPE_REBASE_AFTER || '')
    : rewriteRebaseTodoMany(todo, action, targets));
`;

export const messageEditorSource = String.raw`
const fs = require('node:fs');
const file = process.argv[2];
const message = process.env.GITLOUPE_REBASE_MESSAGE || '';
if (message) fs.writeFileSync(file, message.trim() + '\n');
`;

export function nodeScriptCommand(script: string): string {
  const quote = (value: string): string => `"${value.replaceAll('"', '\\"')}"`;
  return `${quote(process.execPath)} ${quote(script)}`;
}
