export type RebaseTodoAction = 'reword' | 'squash' | 'drop';

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

export const sequenceEditorSource = String.raw`
const fs = require('node:fs');
const rewriteRebaseTodoMany = ${rewriteRebaseTodoMany.toString()};
const file = process.argv[2];
const action = process.env.GITLOUPE_REBASE_ACTION;
const targets = JSON.parse(process.env.GITLOUPE_REBASE_TARGETS || '[]');
fs.writeFileSync(file, rewriteRebaseTodoMany(fs.readFileSync(file, 'utf8'), action, targets));
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
