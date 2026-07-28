export interface GraphSearchQuery {
  files: string[];
  changes: string[];
}

export function parseGraphSearchQuery(query: string): GraphSearchQuery {
  const result: GraphSearchQuery = { files: [], changes: [] };
  for (const token of query.match(/(?:[^\s"]+|"[^"]*")+/g) ?? []) {
    const separator = token.indexOf(':');
    if (separator <= 0) continue;
    const key = token.slice(0, separator).toLowerCase();
    const value = unquote(token.slice(separator + 1)).trim();
    if (!value || value.includes('\0')) continue;
    if (key === 'file') result.files.push(value);
    if (key === 'change') result.changes.push(value);
  }
  return result;
}

function unquote(value: string): string {
  return value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value;
}
