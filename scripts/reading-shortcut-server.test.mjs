import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { openLocalRuntime, issueLocalDevice } from './local-server-runtime.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
test('shortcut pairing consumes once, binds authority, and cannot create library access', { timeout: 60000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'crate-shortcut-server-')); let runtime;
  try {
    runtime = await openLocalRuntime({ dataDir: dir });
    const vault = await issueLocalDevice(runtime.db, 'Pairing test');
    const request = async (path, token = '', body = {}, origin = 'https://crate.example') => {
      const response = await runtime.mf.dispatchFetch(`${origin}${path}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'X-Crate-Protocol': '11', 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      return { status: response.status, body: await response.json(), cache: response.headers.get('Cache-Control') };
    };
    const browser = async () => {
      const access = await request('/reading/access', vault.token, { kind: 'reading' });
      return (await request('/reading/exchange', '', { token: access.body.token })).body;
    };
    await request('/reading/policy', vault.token, { enabled: true, folderPath: 'Reading', revision: null });
    const session = await browser();
    const pair = async (owner = session) => {
      const result = await request('/reading/shortcut-pairing', owner.token);
      assert.equal(result.status, 200, JSON.stringify(result)); assert.equal(result.cache, 'no-store');
      assert.equal(result.body.token, undefined); assert.equal(result.body.authorization, undefined);
      const url = new URL(result.body.pairingCode); assert.equal(url.origin, 'https://crate.example'); assert.equal(url.search, '');
      return { token: url.hash.slice(1) };
    };
    assert.equal((await request('/reading/shortcut-pairing')).status, 401);
    assert.equal((await request('/reading/shortcut-pairing', session.token, {}, 'http://crate.example')).status, 400);
    const grant = await pair();
    const saved = await runtime.db.prepare('SELECT * FROM reading_enrollments WHERE token_hash=?').bind(hash(grant.token)).first();
    assert.ok(saved); assert.ok(!JSON.stringify(saved).includes(grant.token));
    assert.equal((await request('/reading/exchange', '', grant)).status, 401);
    assert.equal((await request('/reading/access', session.token, { kind: 'reading' })).status, 403);
    const exchanges = await Promise.all([request('/reading/shortcut-exchange', '', grant), request('/reading/shortcut-exchange', '', grant)]);
    assert.deepEqual(exchanges.map(result => result.status).sort(), [200, 410]);
    const capture = exchanges.find(result => result.status === 200);
    assert.equal(capture.cache, 'no-store');
    assert.equal(capture.body.endpoint, 'https://crate.example/reading/prepare');
    const token = capture.body.authorization.slice('Bearer '.length);
    const credential = await runtime.db.prepare('SELECT * FROM auth_tokens WHERE token_hash=?').bind(hash(token)).first();
    assert.equal(credential.scope, 'reading_capture'); assert.equal(credential.folder_path, 'Reading'); assert.equal(credential.reading_generation, session.generation);
    assert.ok(credential.expires_at <= session.expiresAt);
    assert.equal((await request('/reading/shortcut-pairing', token)).status, 403);
    assert.equal((await request('/reading/access', token, { kind: 'reading' })).status, 403);
    assert.equal((await request('/reading/prepare', token, { url: 'https://example.invalid/test' })).status, 200);
    const replaced = await pair(), current = await pair();
    assert.equal((await request('/reading/shortcut-exchange', '', replaced)).status, 410);
    await runtime.db.prepare('UPDATE reading_enrollments SET expires_at=0 WHERE token_hash=?').bind(hash(current.token)).run();
    assert.equal((await request('/reading/shortcut-exchange', '', current)).status, 410);
    const revoked = await pair();
    await runtime.db.prepare('DELETE FROM auth_tokens WHERE id=?').bind(session.id).run();
    assert.equal((await request('/reading/shortcut-exchange', '', revoked)).status, 410);
    const second = await browser(), expiredIssuer = await pair(second);
    await runtime.db.prepare('UPDATE auth_tokens SET expires_at=0 WHERE id=?').bind(second.id).run();
    assert.equal((await request('/reading/shortcut-exchange', '', expiredIssuer)).status, 410);
    await runtime.db.prepare('UPDATE auth_tokens SET expires_at=? WHERE id=?').bind(second.expiresAt, second.id).run();
    const disabled = await pair(second);
    await runtime.db.prepare('UPDATE reading_policy SET enabled=0').run();
    assert.equal((await request('/reading/shortcut-exchange', '', disabled)).status, 410);
    await runtime.db.prepare('UPDATE reading_policy SET enabled=1').run();
    const changed = await pair(second);
    await runtime.db.prepare("UPDATE reading_policy SET generation='changed'").run();
    assert.equal((await request('/reading/shortcut-exchange', '', changed)).status, 410);
    assert.equal((await request('/reading/shortcut-pairing', second.token)).status, 401);
    assert.equal((await request('/reading/shortcut-exchange', '', { token: 'bad' })).status, 410);
    // Pairing does not save files or leak into an article handoff.
    assert.equal((await request('/reading/handoff', grant.token)).status, 401);
    assert.equal((await runtime.db.prepare('SELECT count(*) AS count FROM files').first()).count, 0);
    assert.equal((await runtime.db.prepare("SELECT count(*) AS count FROM auth_tokens WHERE scope='reading_capture'").first()).count, 1);
  } finally { await runtime?.close(); await rm(dir, { recursive: true, force: true }); }
});
