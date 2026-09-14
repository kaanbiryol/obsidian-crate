import { queryRows } from './db';
import { portablePathKey } from '../../protocol/portable-path';

export interface ObjectReference { storageKey: string; path?: string | null }
export function objectReference(value: string | ObjectReference): ObjectReference {
  return typeof value === 'string' ? { storageKey: value } : value;
}

/** Immutable keys are never reused or transferred to a different file.
 * Old intents without an owner use a conservative scan, only during cleanup. */
export async function findReferencedStorageKeys(db: D1Database, input: readonly (string | ObjectReference)[]): Promise<Set<string>> {
  const referenced = new Set<string>();
  const objects = input.map(objectReference);
  if (!objects.length) return referenced;
  const json = JSON.stringify(objects.map(object => ({ key: object.storageKey, portable: object.path == null ? null : portablePathKey(object.path) })));
  const legacy = objects.some(object => object.path == null);
  const rows = await queryRows<{ storage_key: string }>(db.prepare(`WITH input AS (
    SELECT json_extract(value, '$.key') AS key, json_extract(value, '$.portable') AS portable FROM json_each(?))
    SELECT f.storage_key FROM input i JOIN files f ON f.portable_path = i.portable AND f.storage_key = i.key
    UNION SELECT storage_key FROM file_versions WHERE storage_key IN (SELECT key FROM input)
    ${legacy ? 'UNION SELECT storage_key FROM files WHERE storage_key IN (SELECT key FROM input WHERE portable IS NULL)' : ''}`)
    .bind(json));
  for (const row of rows) referenced.add(row.storage_key);
  return referenced;
}
