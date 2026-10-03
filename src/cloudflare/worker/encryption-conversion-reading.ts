import type { EncryptionServerState } from '../../encryption/server-state';
import { ENCRYPTED_FILE_CONTENT_TYPE } from '../../encryption/file-format';
import { portablePathKey } from '../../protocol/portable-path';
import { ENCRYPTION_FILE_PREFIX, validateEncryptedContent } from './encryption-state';
import { sha256Hex } from './auth';
import { createManagedObjectKey } from './sync-storage';
import { corsResponse } from './cors';
import { parseJsonObject } from './utils';
import type { Env } from './types';

export const convertedCapturePath = (folder: string, id: string) => `${folder}/Article ${id}.md`;

/** Convert queued bookmarks directly into encrypted vault notes. The coordinator
 * serializes conversion/reset; queue removal and publication are one transaction. */
export async function convertReadingCapture(request: Request, env: Env, state: EncryptionServerState): Promise<Response> {
  const parsed = await parseJsonObject(request, 4 * 1024 * 1024);
  if (!parsed.ok) return parsed.response;
  const { id, content } = parsed.value;
  if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id) || typeof content !== 'string') return corsResponse({ error: 'Invalid encrypted Reading capture' }, 400);
  const capture = await env.DB.prepare('SELECT generation FROM reading_captures WHERE id=?').bind(id).first<{ generation: string }>();
  if (!capture) return corsResponse({ converted: true });
  const policy = await env.DB.prepare('SELECT folder_path FROM reading_policy WHERE generation=?').bind(capture.generation).first<{ folder_path: string }>();
  if (!policy) return corsResponse({ error: 'Restore the Reading destination before converting its pending captures' }, 409);
  const path = convertedCapturePath(policy.folder_path, id);
  const descriptor = validateEncryptedContent(state, path, content);
  if (await env.DB.prepare('SELECT 1 FROM files WHERE portable_path=?').bind(portablePathKey(path)).first()) return corsResponse({ error: 'A note occupies a pending Reading capture path. Resolve it before conversion.' }, 409);
  const hash = await sha256Hex(content), size = new TextEncoder().encode(content).length;
  const key = createManagedObjectKey(hash);
  // A crash leaves only ciphertext, reclaimed by the conversion orphan sweep.
  await env.BUCKET.put(key, content, { httpMetadata: { contentType: ENCRYPTED_FILE_CONTENT_TYPE }, customMetadata: { hash } });
  await env.DB.batch([
    env.DB.prepare('INSERT INTO files(path,portable_path,hash,size,storage_key) VALUES (?,?,?,?,?)').bind(path, portablePathKey(path), hash, size, key),
    env.DB.prepare('INSERT INTO maintenance_state(key,value) VALUES (?,?)').bind(ENCRYPTION_FILE_PREFIX + key, JSON.stringify(descriptor)),
    env.DB.prepare('DELETE FROM reading_captures WHERE id=?').bind(id),
  ]);
  return corsResponse({ converted: true });
}
