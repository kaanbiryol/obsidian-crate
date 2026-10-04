import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { openLocalRuntime, issueLocalDevice } from './local-server-runtime.mjs';
import { readingShortcutWithFirstRunSetup } from './reading-shortcut-first-run.mjs';
import { shortcutTemplate, shortcutIdentifier, shortcutRequest } from './reading-shortcut-fixture.mjs';
import contract from '../src/reading/shortcut-contract.json' with { type: 'json' };

const hash = value => createHash('sha256').update(value).digest('hex');
test('the distributed pairing and save requests reach a durable Reading receipt', { timeout: 60000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'crate-shortcut-capture-')); let runtime;
  try {
    runtime = await openLocalRuntime({ dataDir: dir });
    const vault = await issueLocalDevice(runtime.db, 'Shortcut capture test');
    const origin = 'https://crate.example';
    const dispatch = async ({ url, ...init }) => {
      const response = await runtime.mf.dispatchFetch(url, init);
      return { status: response.status, body: await response.json() };
    };
    const api = (path, body, extraHeaders = {}) => dispatch({ url: `${origin}${path}`, method: 'POST',
      headers: { Authorization: `Bearer ${vault.token}`, 'X-Crate-Protocol': '1', 'Content-Type': 'application/json', ...extraHeaders }, body: JSON.stringify(body) });
    // A Twitter link must remain saved even when full-article fetching is off.
    assert.equal((await api('/reading/policy', { enabled: false, folderPath: 'Reading', revision: null })).status, 200);
    const pairing = await api('/reading/shortcut-pairing', {});
    assert.equal(pairing.status, 200);
    const code = new URL(pairing.body.pairingCode);
    const actions = readingShortcutWithFirstRunSetup(shortcutTemplate, { pairing: true }).WFWorkflowActions;
    const [exchangeAction, prepareAction] = actions.filter(action => shortcutIdentifier(action) === 'downloadurl');
    const reference = text => text.Value.attachmentsByRange['{0, 1}'].OutputUUID;
    const exchangeParameters = exchangeAction.WFWorkflowActionParameters;
    const exchange = await dispatch(shortcutRequest(exchangeAction, {
      [reference(exchangeParameters.WFURL)]: `${code.origin}${contract.exchangePath}`,
      [reference(exchangeParameters.WFJSONValues.Value.WFDictionaryFieldValueItems[0].WFValue)]: code.hash.slice(1),
    }));
    assert.equal(exchange.status, 200, JSON.stringify(exchange));
    const sharedUrl = 'https://x.com/crate/status/123456789';
    const outputs = {
      [shortcutTemplate.WFWorkflowActions[0].WFWorkflowActionParameters.UUID]: exchange.body.endpoint,
      [shortcutTemplate.WFWorkflowActions[1].WFWorkflowActionParameters.UUID]: exchange.body.authorization,
      [shortcutTemplate.WFWorkflowActions[3].WFWorkflowActionParameters.UUID]: sharedUrl,
    };
    const saveRequest = shortcutRequest(prepareAction, outputs);
    // Retired protocols cannot bypass the wire gate.
    const rejected = await api('/reading/prepare', { url: sharedUrl }, { 'X-Crate-Protocol': '11' });
    assert.equal(rejected.status, 428);
    const unrelated = await dispatch({ ...saveRequest, url: `${origin}/reading/capture`, headers: { ...saveRequest.headers, 'X-Crate-Protocol': '11' } });
    assert.equal(unrelated.status, 428);
    const prepared = await dispatch(saveRequest);
    assert.equal(prepared.status, 200, JSON.stringify(prepared));
    const launch = new URL(prepared.body.launchUrl);
    assert.equal(launch.pathname, '/notifications/save-reading');
    assert.equal((await runtime.db.prepare('SELECT count(*) AS count FROM files').first()).count, 0);
    const commit = () => api('/reading/handoff', {}, { 'X-Crate-Capture': launch.hash.slice(1) });
    const saved = await commit();
    assert.equal(saved.status, 200, JSON.stringify(saved));
    assert.equal(saved.body.saved, true);
    assert.deepEqual(await commit(), saved);
    const listResponse = await runtime.mf.dispatchFetch(`${origin}/reading/list`, { headers: { Authorization: `Bearer ${vault.token}` } });
    assert.equal(listResponse.status, 200);
    const list = await listResponse.json();
    assert.equal(list.items.length, 1);
    assert.equal(list.items[0].crate_reading_id, saved.body.id);
    assert.equal(list.items[0].source_url, sharedUrl);
    assert.ok(list.items[0].path.startsWith('Reading/'));
    const duplicate = await dispatch(saveRequest);
    assert.equal(duplicate.status, 200);
    const replay = await api('/reading/handoff', {}, { 'X-Crate-Capture': new URL(duplicate.body.launchUrl).hash.slice(1) });
    assert.equal(replay.status, 200);
    assert.deepEqual(replay.body, { saved: true, alreadySaved: true, id: saved.body.id });
    assert.equal((await runtime.db.prepare('SELECT count(*) AS count FROM files').first()).count, 1);
    const missingAccess = await dispatch({ ...saveRequest, headers: { ...saveRequest.headers, Authorization: 'Bearer expired-access' } });
    assert.equal(missingAccess.status, 401);
    const diagnostic = JSON.parse(decodeURIComponent(new URL(missingAccess.body.launchUrl).hash.slice('#error='.length)));
    assert.equal(diagnostic.stage, 'prepare'); assert.equal(diagnostic.status, 401);
    assert.equal(diagnostic.shortcutRevision, contract.revision);
    for (const secret of [exchange.body.authorization.slice(7), code.hash.slice(1), sharedUrl, 'expired-access']) assert.ok(!missingAccess.body.launchUrl.includes(secret));
    const invalidBody = await dispatch({ ...saveRequest, body: JSON.stringify({ url: sharedUrl, operationId: 'not-a-shortcut-field' }) });
    assert.equal(invalidBody.status, 400); assert.equal(invalidBody.body.code, 'invalid_shortcut_request');
    const newerContract = await dispatch({ ...saveRequest, url: `${origin}/reading/shortcut/v2/prepare` });
    assert.equal(newerContract.status, 426); assert.equal(newerContract.body.code, 'server_update_required');
    const vaultNative = await dispatch({ ...saveRequest, headers: { ...saveRequest.headers, Authorization: `Bearer ${vault.token}` } });
    assert.equal(vaultNative.status, 403);
  } finally { await runtime?.close(); await rm(dir, { recursive: true, force: true }); }
});

test('shortcut pairing consumes once, binds authority, and cannot create library access', { timeout: 60000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'crate-shortcut-server-')); let runtime;
  try {
    runtime = await openLocalRuntime({ dataDir: dir });
    const vault = await issueLocalDevice(runtime.db, 'Pairing test');
    const request = async (path, token = '', body = {}, origin = 'https://crate.example') => {
      const response = await runtime.mf.dispatchFetch(`${origin}${path}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'X-Crate-Protocol': '1', 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      return { status: response.status, body: await response.json(), cache: response.headers.get('Cache-Control') };
    };
    const browser = async () => {
      const access = await request('/reading/access', vault.token, { kind: 'reading' });
      return (await request('/reading/exchange', '', { token: access.body.token })).body;
    };
    await request('/reading/policy', vault.token, { enabled: true, folderPath: 'Reading', revision: null });
    const session = await browser();
    const remindersExpiry = Date.now() + 60_000;
    await runtime.db.prepare("INSERT INTO auth_tokens(id,token_hash,scope,folder_path,expires_at) VALUES ('reminders-browser',?,'reminders','Reminders',?)")
      .bind(hash('reminders-browser'), remindersExpiry).run();
    const remindersPair = await request('/reading/shortcut-pairing', 'reminders-browser');
    assert.equal(remindersPair.status, 200);
    const remindersGrant = { token: new URL(remindersPair.body.pairingCode).hash.slice(1) };
    const remindersCapture = await request(contract.exchangePath, '', remindersGrant);
    assert.equal(remindersCapture.status, 200);
    const remindersCredential = await runtime.db.prepare('SELECT expires_at FROM auth_tokens WHERE token_hash=?')
      .bind(hash(remindersCapture.body.authorization.slice('Bearer '.length))).first();
    assert.ok(remindersCredential.expires_at <= remindersExpiry);
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
    const exchanges = await Promise.all([request(contract.exchangePath, '', grant), request(contract.exchangePath, '', grant)]);
    assert.deepEqual(exchanges.map(result => result.status).sort(), [200, 410]);
    const capture = exchanges.find(result => result.status === 200);
    assert.equal(capture.cache, 'no-store');
    assert.equal(capture.body.endpoint, `https://crate.example${contract.preparePath}`);
    const token = capture.body.authorization.slice('Bearer '.length);
    const credential = await runtime.db.prepare('SELECT * FROM auth_tokens WHERE token_hash=?').bind(hash(token)).first();
    assert.equal(credential.scope, 'reading_capture'); assert.equal(credential.folder_path, 'Reading'); assert.equal(credential.reading_generation, session.generation);
    assert.ok(credential.expires_at <= session.expiresAt);
    assert.equal((await request('/reading/shortcut-pairing', token)).status, 403);
    assert.equal((await request('/reading/access', token, { kind: 'reading' })).status, 403);
    assert.equal((await request('/reading/prepare', token, { url: 'https://example.invalid/test' })).status, 200);
    const replaced = await pair(), current = await pair();
    assert.equal((await request(contract.exchangePath, '', replaced)).status, 410);
    await runtime.db.prepare('UPDATE reading_enrollments SET expires_at=0 WHERE token_hash=?').bind(hash(current.token)).run();
    assert.equal((await request(contract.exchangePath, '', current)).status, 410);
    const revoked = await pair();
    await runtime.db.prepare('DELETE FROM auth_tokens WHERE id=?').bind(session.id).run();
    assert.equal((await request(contract.exchangePath, '', revoked)).status, 410);
    const second = await browser(), expiredIssuer = await pair(second);
    await runtime.db.prepare('UPDATE auth_tokens SET expires_at=0 WHERE id=?').bind(second.id).run();
    assert.equal((await request(contract.exchangePath, '', expiredIssuer)).status, 410);
    await runtime.db.prepare('UPDATE auth_tokens SET expires_at=? WHERE id=?').bind(second.expiresAt, second.id).run();
    // Fetching consent does not revoke permission to pair and save bookmarks.
    const disabled = await pair(second);
    await runtime.db.prepare('UPDATE reading_policy SET enabled=0').run();
    assert.equal((await request(contract.exchangePath, '', disabled)).status, 200);
    await runtime.db.prepare('UPDATE reading_policy SET enabled=1').run();
    const changed = await pair(second);
    await runtime.db.prepare("UPDATE reading_policy SET generation='changed'").run();
    assert.equal((await request(contract.exchangePath, '', changed)).status, 410);
    assert.equal((await request('/reading/shortcut-pairing', second.token)).status, 401);
    assert.equal((await request(contract.exchangePath, '', { token: 'bad' })).status, 410);
    // Pairing does not save files or leak into an article handoff.
    assert.equal((await request('/reading/handoff', grant.token)).status, 401);
    assert.equal((await runtime.db.prepare('SELECT count(*) AS count FROM files').first()).count, 0);
    assert.equal((await runtime.db.prepare("SELECT count(*) AS count FROM auth_tokens WHERE scope='reading_capture'").first()).count, 3);
  } finally { await runtime?.close(); await rm(dir, { recursive: true, force: true }); }
});
