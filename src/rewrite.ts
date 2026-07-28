export type RebaseTodoAction = 'reword' | 'squash' | 'drop';

export function rewriteRebaseTodo(todo: string, action: RebaseTodoAction, target: string): string {
  const lines = todo.split(/\r?\n/);
  let changed = false;
  for (let index = 0; index < lines.length; index++) {
    const match = /^(pick)\s+([0-9a-f]+)\s+/.exec(lines[index] ?? '');
    if (!match || !(target.startsWith(match[2]!) || match[2]!.startsWith(target))) continue;
    lines[index] = lines[index]!.replace(/^pick/, action);
    changed = true;
  }
  if (!changed) throw new Error('Target commit was not present in the rebase plan.');
  return lines.join('\n');
}

export const sequenceEditorSource = String.raw`
const fs = require('node:fs');
const rewriteRebaseTodo = ${rewriteRebaseTodo.toString()};
const file = process.argv[2];
const action = process.env.GITLOUPE_REBASE_ACTION;
const target = process.env.GITLOUPE_REBASE_TARGET || '';
fs.writeFileSync(file, rewriteRebaseTodo(fs.readFileSync(file, 'utf8'), action, target));
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
