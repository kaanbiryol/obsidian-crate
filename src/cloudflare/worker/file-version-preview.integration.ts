/// <reference types="@cloudflare/vitest-plugin/types" />
import { afterEach, beforeEach, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import schema from '../schema.sql?raw';
import { handleFileVersionPreview } from './file-version-preview';
import { sha256Hex } from './auth';
beforeEach(async () => {
 for (const sql of schema.split(';').map(value => value.trim()).filter(Boolean)) await env.DB.prepare(sql).run();
 const hash = await sha256Hex('saved');
 await env.DB.prepare("INSERT INTO file_versions (storage_key,path,hash,size,reason,expires_at) VALUES ('retained/key','note.md',?,5,'deleted',?)").bind(hash, Date.now() + 300_000).run();
 await env.BUCKET.put('retained/key', 'saved', { customMetadata: { hash } });
});
afterEach(async () => { await reset(); });
const preview = (path = 'note.md', key = 'retained/key') => handleFileVersionPreview(new Request(`https://test/sync/version-preview?${new URLSearchParams({ path, storageKey: key })}`), env.BUCKET, env.DB);
it('returns verified bytes without restoring or changing retained data', async () => {
 const response = await preview();
 expect(response.status).toBe(200); expect(new TextDecoder().decode(await response.arrayBuffer())).toBe('saved');
 expect(response.headers.get('Cache-Control')).toBe('private, no-store');
 expect(await env.DB.prepare('SELECT * FROM files').first()).toBeNull();
 expect(await env.DB.prepare('SELECT * FROM changelog').first()).toBeNull();
 expect(await env.DB.prepare('SELECT * FROM file_versions').first()).not.toBeNull();
});
it('refuses expired versions, mismatched paths and unretained R2 keys', async () => {
 expect((await preview('other.md')).status).toBe(404);
 expect((await preview('note.md', 'arbitrary/key')).status).toBe(404);
 await env.DB.prepare('UPDATE file_versions SET expires_at = 0').run();
 expect((await preview()).status).toBe(404);
});
it('bounds reads and rejects corrupt stored bytes', async () => {
 await env.BUCKET.put('retained/key', 'wrong', { customMetadata: { hash: await sha256Hex('saved') } });
 expect((await preview()).status).toBe(503);
 await env.DB.prepare('UPDATE file_versions SET size = 256001').run();
 expect((await preview()).status).toBe(413);
});
