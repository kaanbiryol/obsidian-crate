import { queryRows } from './db';
import { portablePathKey } from '../../protocol/portable-path';

export interface ObjectReference { storageKey: string; path: string }

/** Immutable keys are never reused or transferred to a different file. */
export async function findReferencedStorageKeys(db: D1Database, objects: readonly ObjectReference[]): Promise<Set<string>> {
  const referenced = new Set<string>();
  if (!objects.length) return referenced;
  const json = JSON.stringify(objects.map(object => ({ key: object.storageKey, portable: portablePathKey(object.path) })));
  const rows = await queryRows<{ storage_key: string }>(db.prepare(`WITH input AS (
    SELECT json_extract(value, '$.key') AS key, json_extract(value, '$.portable') AS portable FROM json_each(?))
    SELECT f.storage_key FROM input i JOIN files f ON f.portable_path = i.portable AND f.storage_key = i.key
    UNION SELECT storage_key FROM file_versions WHERE storage_key IN (SELECT key FROM input)`)
    .bind(json));
  for (const row of rows) referenced.add(row.storage_key);
  return referenced;
}
