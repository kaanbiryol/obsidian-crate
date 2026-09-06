import { assertPortablePaths, portablePathKey } from '../protocol/portable-path';
import type { CloudflareApiClient } from './cloudflare-api';

/** Run after installing the protocol gate, while new clients are fenced by the marker. */
export async function normalizeDeployedPortablePaths(api: CloudflareApiClient, accountId: string, databaseId: string): Promise<void> {
  const query = (sql: string, params?: string[]) => api.queryD1(accountId, databaseId, sql, params);
  const marker = await query("SELECT value FROM maintenance_state WHERE key = 'portable_paths_ready'");
  if (marker.some(result => result.results?.some(row => row.value === 'true'))) return;
  const paths: string[] = [];
  let after = '';
  while (true) {
    const page = (await query('SELECT path FROM files WHERE path > ? ORDER BY path LIMIT 2000', [after]))
      .flatMap(result => result.results ?? []).map(row => row.path).filter((path): path is string => typeof path === 'string');
    paths.push(...page);
    if (page.length < 2000) break;
    after = page.at(-1) ?? after;
  }
  // A collision leaves all content and names intact and the write gate closed.
  // The deployment can be retried after the conflicting legacy names are resolved.
  assertPortablePaths(paths);
  await query("UPDATE files SET portable_path = '__crate_migration__/' || hex(randomblob(16))");
  for (let i = 0; i < paths.length; i += 40) {
    const chunk = paths.slice(i, i + 40);
    await query(chunk.map(() => 'UPDATE files SET portable_path = ? WHERE path = ?;').join('\n'),
      chunk.flatMap(path => [portablePathKey(path), path]));
  }
  await query("INSERT INTO maintenance_state (key, value) VALUES ('portable_paths_ready', 'true') ON CONFLICT(key) DO UPDATE SET value = 'true', updated_at = datetime('now')");
}
