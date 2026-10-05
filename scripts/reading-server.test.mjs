import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { openLocalRuntime, issueLocalDevice, localNetworkOptions } from '../packages/server/src/local-server-runtime.mjs';

const operation = () => `e1_${String(Math.floor(Date.now() / 86400000)).padStart(8, '0')}_${randomUUID()}`;
test('Reading recovers an unavailable source across server restart without duplicate capture', { timeout: 60000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'crate-reading-recovery-')); let runtime;
  try {
    runtime = await openLocalRuntime({ dataDir: dir });
    const vault = await issueLocalDevice(runtime.db, 'Reading recovery');
    const request = async (path, body) => {
      const response = await runtime.mf.dispatchFetch(`http://localhost:8787${path}`, { method: body === undefined ? 'GET' : 'POST',
        headers: { Authorization: `Bearer ${vault.token}`, 'X-Crate-Protocol': '1', 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: response.status, body: await response.json() };
    };
    assert.equal((await request('/reading/policy', { enabled: false, folderPath: 'Reading', revision: null })).status, 200);
    const capture = { url: 'https://example.invalid/recovery', fetchArticle: false, operationId: operation() };
    const saved = await request('/reading/capture', capture);
    assert.equal(saved.status, 200);
    const file = await runtime.db.prepare('SELECT path,storage_key FROM files').first();
    const bucket = await runtime.mf.getR2Bucket('BUCKET');
    const bytes = await (await bucket.get(file.storage_key)).arrayBuffer();
    // The next projection must read this source; simulate temporary loss of its object.
    await runtime.db.prepare('DELETE FROM reading_sources').run();
    await bucket.delete(file.storage_key);
    assert.equal((await request('/reading/list')).status, 503);
    const retry = { ...capture, operationId: operation() };
    assert.equal((await request('/reading/capture', retry)).status, 503);
    await runtime.close(); runtime = await openLocalRuntime({ dataDir: dir });
    await (await runtime.mf.getR2Bucket('BUCKET')).put(file.storage_key, bytes);
    const listed = await request('/reading/list');
    assert.equal(listed.status, 200); assert.equal(listed.body.items.length, 1);
    assert.equal(listed.body.items[0].crate_reading_id, saved.body.id);
    const deduplicated = await request('/reading/capture', retry);
    assert.equal(deduplicated.status, 200); assert.equal(deduplicated.body.alreadySaved, true);
    assert.equal(deduplicated.body.id, saved.body.id);
    assert.equal((await runtime.db.prepare('SELECT count(*) AS n FROM files').first()).n, 1);
    assert.equal((await runtime.db.prepare('SELECT storage_key FROM files').first()).storage_key, file.storage_key);
  } finally { await runtime?.close(); await rm(dir, { recursive: true, force: true }); }
});

test('built server captures, replays, isolates scopes and confirms browser handoffs', { timeout: 60000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'crate-reading-')); let runtime;
  try {
    runtime = await openLocalRuntime({ dataDir: dir });
    const vault = await issueLocalDevice(runtime.db, 'Reading test');
    const request = async (path, token = vault.token, body, headers = {}) => {
      const response = await runtime.mf.dispatchFetch(`http://localhost:8787${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${token}`, 'X-Crate-Protocol': '1', 'Content-Type': 'application/json', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
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
    const body = { url: 'https://example.invalid/article?secret=never-log-me', fetchArticle: false, operationId: operation() };
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
    assert.equal(page.headers.get('Cache-Control'), 'no-store'); assert.match(await page.text(), /<title>Save to Crate<\/title>/);
    const manifest = await (await runtime.mf.dispatchFetch('http://localhost:8787/notifications/manifest.json')).json();
    assert.equal(manifest.id, '/notifications'); assert.equal(manifest.share_target.action, '/notifications/share/reading');
    assert.equal((await runtime.db.prepare('SELECT (SELECT count(*) FROM files)+(SELECT count(*) FROM reading_captures) AS count').first()).count, 2);
  } finally { await runtime?.close(); await rm(dir, { recursive: true, force: true }); }
});

test('rejects an old development database without changing its data', { timeout: 60000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'crate-reading-baseline-')); let runtime;
  try {
    runtime = await openLocalRuntime({ dataDir: dir, administrative: true });
    await runtime.db.prepare("INSERT INTO files(path,portable_path,hash,size,storage_key) VALUES ('test.md','test.md','hash',5,'old-key')").run();
    await runtime.close(); runtime = null;
    const metadataPath = join(dir, 'server.json');
    const metadata = JSON.parse(await readFile(metadataPath, 'utf8'));
    const currentMetadata = { ...metadata };
    metadata.schemaHash = 'old-development-schema';
    await writeFile(metadataPath, JSON.stringify(metadata));
    await assert.rejects(openLocalRuntime({ dataDir: dir }), /tested migration/);
    await assert.rejects(openLocalRuntime({ dataDir: dir, administrative: true, upgradeBackup: join(dir, 'backup') }), /tested migration/);
    assert.deepEqual(JSON.parse(await readFile(metadataPath, 'utf8')), metadata);
    // Restore only the test's fabricated marker and inspect the original rows.
    await writeFile(metadataPath, JSON.stringify(currentMetadata));
    runtime = await openLocalRuntime({ dataDir: dir, administrative: true });
    assert.equal((await runtime.db.prepare('SELECT storage_key FROM files').first()).storage_key, 'old-key');
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

test('production local outbound policy blocks private connections through global and bound fetch', { timeout: 30000 }, async () => {
  const { createServer } = await import('node:http');
  const { Miniflare, convertV4MiniflareOptions } = await import('miniflare');
  let hits = 0, runtime;
  const server = createServer((_request, response) => { hits++; response.end('private fixture'); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  try {
    const options = {
      name: 'crate-network-regression', modules: true, host: '127.0.0.1', port: 0, cf: false, telemetry: { enabled: false },
      compatibilityDate: '2026-08-18', compatibilityFlags: ['global_fetch_strictly_public'],
      ...localNetworkOptions(),
      script: `export default { async fetch(request, env) {
        const { target, bound } = await request.json();
        try {
          const result = await (bound ? env.READING_FETCH.fetch(target) : fetch(target));
          await result.body?.cancel();
          return Response.json({ rejected: !result.ok });
        } catch { return Response.json({ rejected: true }); }
      } };`,
    };
    const probe = (host, bound) => runtime.dispatchFetch('http://localhost/probe', {
      method: 'POST', body: JSON.stringify({ target: `http://${host}:${server.address().port}/`, bound }),
    }).then(response => response.json());
    // A reachable-fixture control catches false passes from a broken runtime or
    // listener. Only this test instance permits the owned loopback destination.
    runtime = new Miniflare(convertV4MiniflareOptions({ ...options, outboundService: undefined }));
    assert.deepEqual(await probe('127.0.0.1', false), { rejected: false });
    assert.equal(hits, 1);
    await runtime.dispose();
    hits = 0;
    runtime = new Miniflare(convertV4MiniflareOptions(options));
    for (const host of ['127.0.0.1', 'localhost']) for (const bound of [false, true]) {
      assert.deepEqual(await probe(host, bound), { rejected: true }, `${bound ? 'Bound' : 'Global'} fetch must reject ${host}`);
    }
    assert.equal(hits, 0, 'No private fixture may receive a request');
  } finally { await runtime?.dispose(); await new Promise(resolve => server.close(resolve)); }
});
