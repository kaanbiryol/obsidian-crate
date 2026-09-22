import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { openLocalRuntime, issueLocalDevice } from './local-server-runtime.mjs';

const operation = () => `e1_${String(Math.floor(Date.now() / 86400000)).padStart(8, '0')}_${randomUUID()}`;
test('built server captures, replays, isolates scopes and confirms browser handoffs', { timeout: 60000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'crate-reading-')); let runtime;
  try {
    runtime = await openLocalRuntime({ dataDir: dir });
    const vault = await issueLocalDevice(runtime.db, 'Reading test');
    const request = async (path, token = vault.token, body, headers = {}) => {
      const response = await runtime.mf.dispatchFetch(`http://localhost:8787${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${token}`, 'X-Crate-Protocol': '11', 'Content-Type': 'application/json', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: response.status, body: await response.json() };
    };
    let result = await request('/reading/policy', vault.token, { enabled: true, folderPath: 'Reading', revision: null });
    assert.equal(result.status, 200, JSON.stringify(result));
    const enrollment = await request('/reading/access', vault.token, { kind: 'reading' });
    const grant = new URL(enrollment.body.url).hash.slice('#reading='.length);
    const browser = await request('/reading/exchange', '', { token: grant });
    assert.equal(browser.status, 200, JSON.stringify(browser));
    const installed = await request('/reading/exchange', '', { token: browser.body.installToken });
    assert.equal(installed.status, 200); assert.equal(installed.body.installToken, undefined);
    assert.equal((await request('/reading/install', browser.body.token, {})).status, 404);
    assert.equal((await request('/reading/access', browser.body.token, {kind:'reading'})).status, 403);
    assert.equal((await request('/reading/exchange', '', { token: grant })).status, 401);
    const capture = await request('/reading/access', vault.token, { kind: 'capture' });
    assert.equal((await request('/reading/list', capture.body.token)).status, 403);
    assert.equal((await request('/sync/manifest', browser.body.token)).status, 403);
    const body = { url: 'https://example.invalid/article?secret=never-log-me', operationId: operation() };
    const first = await request('/reading/capture', capture.body.token, body);
    assert.equal(first.status, 200, JSON.stringify(first)); assert.ok(first.body.saved);
    assert.deepEqual(await request('/reading/capture', capture.body.token, body), first);
    assert.equal((await request('/reading/capture', capture.body.token, { ...body, url: 'https://example.invalid/other' })).status, 409);
    const duplicate = await request('/reading/capture', browser.body.token, { ...body, operationId: operation() });
    assert.equal(duplicate.body.id, first.body.id); assert.equal(duplicate.body.alreadySaved, true);
    let listed = await request('/reading/list', browser.body.token);
    assert.equal(listed.body.items.length, 1, JSON.stringify(listed));
    const item = listed.body.items[0];
    const detail = await request(`/reading/item?id=${item.crate_reading_id}`, browser.body.token);
    assert.equal(detail.status, 200); assert.match(detail.body.markdown, /crate:article:start/);
    result = await request('/reading/update', browser.body.token, { id: item.crate_reading_id, changes: { favorite: true }, before: { favorite: false }, operationId: operation() });
    assert.equal(result.status, 200, JSON.stringify(result));
    listed = await request('/reading/list', browser.body.token); assert.equal(listed.body.items[0].favorite, true);
    const prepared = await request('/reading/prepare', capture.body.token, { url: 'https://example.invalid/phone', title: 'Phone capture' });
    assert.equal(prepared.status, 200, JSON.stringify(prepared));
    const launch = new URL(prepared.body.launchUrl); assert.equal(launch.pathname, '/notifications/save-reading'); assert.equal(launch.search, '');
    const handoff = await request('/reading/handoff', '', {}, { 'X-Crate-Capture': launch.hash.slice(1) });
    assert.equal(handoff.status, 200, JSON.stringify(handoff)); assert.ok(handoff.body.saved);
    assert.deepEqual(await request('/reading/handoff', '', {}, { 'X-Crate-Capture': launch.hash.slice(1) }), handoff);
    await runtime.db.prepare('DELETE FROM auth_tokens WHERE id=?').bind(capture.body.id).run();
    assert.equal((await request('/reading/handoff', '', {}, { 'X-Crate-Capture': launch.hash.slice(1) })).status, 410);
    const page = await runtime.mf.dispatchFetch('http://localhost:8787/notifications/save-reading');
    assert.equal(page.headers.get('Cache-Control'), 'no-store'); assert.match(await page.text(), /Saving to Crate/);
    const manifest = await (await runtime.mf.dispatchFetch('http://localhost:8787/notifications/manifest.json')).json();
    assert.equal(manifest.id, '/notifications'); assert.equal(manifest.share_target.action, '/notifications/share/reading');
    assert.equal((await runtime.db.prepare('SELECT count(*) AS count FROM files').first()).count, 2);
  } finally { await runtime?.close(); await rm(dir, { recursive: true, force: true }); }
});

test('populated schema 1 upgrades only after a verified stopped backup, preserves data and retries safely', { timeout: 60000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'crate-reading-upgrade-')), dataDir = join(dir, 'data'); let runtime;
  try {
    runtime = await openLocalRuntime({ dataDir, administrative: true });
    const db = runtime.db;
    const tables = (await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'").all()).results;
    for (const { name } of tables) await db.prepare(`DROP TABLE "${name}"`).run();
    const baseline = await readFile(new URL('../src/cloudflare/migrations/schema-v1.sql', import.meta.url), 'utf8');
    await db.batch(baseline.split(';').map(s => s.trim()).filter(Boolean).map(s => db.prepare(s)));
    await issueLocalDevice(db, 'Existing device');
    await db.prepare("INSERT INTO files(path,portable_path,hash,size,storage_key) VALUES ('test.md','test.md','hash',5,'old-key')").run();
    await db.prepare("INSERT INTO web_enrollment_tokens(token_hash,folder_path,expires_at) VALUES ('old-enrollment','Reminders',9999999999999)").run();
    await runtime.close(); runtime = null;
    const metadataPath = join(dataDir, 'server.json');
    const metadata = JSON.parse(await readFile(metadataPath, 'utf8'));
    metadata.schemaHash = createHash('sha256').update(baseline).digest('hex'); metadata.serverRevision = 59;
    await writeFile(metadataPath, JSON.stringify(metadata));
    await assert.rejects(openLocalRuntime({ dataDir }), /tested migration/);
    runtime = await openLocalRuntime({ dataDir, administrative: true, upgradeBackup: join(dir, 'backup') });
    assert.equal((await runtime.db.prepare('SELECT version FROM crate_schema').first()).version, 2);
    assert.equal((await runtime.db.prepare('SELECT count(*) AS count FROM auth_tokens').first()).count, 1);
    assert.equal((await runtime.db.prepare('SELECT storage_key FROM files').first()).storage_key, 'old-key');
    assert.equal((await runtime.db.prepare('SELECT count(*) AS count FROM web_enrollment_tokens').first()).count, 1);
    await runtime.close(); runtime = null;
    const saved = JSON.parse(await readFile(join(dir, 'backup/data/server.json'), 'utf8')); assert.equal(saved.schemaHash, metadata.schemaHash);
    runtime = await openLocalRuntime({ dataDir, administrative: true });
    assert.equal((await runtime.db.prepare('SELECT count(*) AS count FROM crate_migrations').first()).count, 1);
  } finally { await runtime?.close(); await rm(dir, { recursive: true, force: true }); }
});

test('local article network binding rejects private addresses after hostname resolution', { timeout: 30000 }, async () => {
  const { createServer } = await import('node:http');
  const dir = await mkdtemp(join(tmpdir(), 'crate-reading-network-')); let runtime; let requests = 0;
  const privateServer = createServer((_request,response) => { requests++; response.end('private data'); });
  await new Promise(resolve => privateServer.listen(0,'127.0.0.1',resolve));
  try {
    runtime = await openLocalRuntime({dataDir:dir,administrative:true});
    const { READING_FETCH } = await runtime.mf.getBindings();
    for (const host of ['127.0.0.1','localhost']) {
      let rejected = false;
      try { const response = await READING_FETCH.fetch(`http://${host}:${privateServer.address().port}/`); rejected = !response.ok; await response.body?.cancel(); } catch { rejected = true; }
      assert.equal(rejected,true,`Native network boundary must reject ${host}`);
    }
    assert.equal(requests,0);
  } finally { await runtime?.close();await new Promise(resolve=>privateServer.close(resolve)); await rm(dir,{recursive:true,force:true}); }
});
