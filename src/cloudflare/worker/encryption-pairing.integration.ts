/// <reference types="@cloudflare/vitest-plugin/types" />
import { afterEach, beforeEach, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import schema from '../schema.sql?raw';
import worker from './index';
import { sha256Hex } from './auth';
import { createEncryptionState } from '../../encryption/server-state';
import { addReminderScope, createVaultKeyBundle, generateRecoveryCode, sealRecoveryBundle, createReminderKeyGrant } from '../../encryption/key-bundle';
import { requestAppPairing, answerAppPairing } from '../../encryption/pairing/session';
import { createPairingRequester, createPairingResponder, type PairingTransport, type PairingContext } from '../../encryption/pairing/protocol';
import { CRATE_PLUGIN_PROTOCOL, CRATE_PROTOCOL_HEADER } from '../../protocol';

beforeEach(async () => { for (const sql of schema.split(';').map(sql => sql.trim()).filter(Boolean)) await env.DB.prepare(sql).run(); });
afterEach(async () => { await reset(); });
const current = () => {};
async function configure() {
  const bundle = addReminderScope(addReminderScope(createVaultKeyBundle(), 'Reminders'), 'Reading', 'reading');
  const recovery = await generateRecoveryCode();
  const state = createEncryptionState(bundle, await sealRecoveryBundle(bundle, recovery)); state.mode = 'active';
  await env.DB.prepare("INSERT INTO maintenance_state(key,value) VALUES ('e2ee:state',?)").bind(JSON.stringify(state)).run();
  await env.DB.prepare("INSERT INTO reading_policy(id,enabled,folder_path,generation,revision) VALUES (1,1,'Reading','reading-generation','revision')").run();
  for (const [token, scope, folder] of [['vault', 'vault', null], ['other-vault', 'vault', null], ['app', 'reminders', 'Reminders'], ['other-app', 'reminders', 'Reminders'], ['reader','reading','Reading'], ['capture','reading_capture','Reading']] as const) {
    await env.DB.prepare('INSERT INTO auth_tokens(id,token_hash,scope,folder_path,reading_generation) VALUES (?,?,?,?,?)').bind(token, await sha256Hex(token), scope, folder, scope.startsWith('reading') ? 'reading-generation' : null).run();
  }
  const context = (reading = false): PairingContext => ({ version: 1, id: crypto.randomUUID(), origin: 'https://test', vaultId: bundle.vaultId, generation: bundle.generation, scopeId: bundle.scopes[reading ? 1 : 0]!.id });
  return { bundle, recovery, state, context };
}
async function send(token: string, body?: Record<string, unknown>, id?: string) {
  return worker.fetch(new Request(`https://test/encryption/pairing${id ? '?id=' + id : ''}`, { method: body ? 'POST' : 'GET', headers: {
    Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', [CRATE_PROTOCOL_HEADER]: String(CRATE_PLUGIN_PROTOCOL.current),
  }, ...(body ? { body: JSON.stringify(body) } : {}) }), env);
}
const transport = (token: string): PairingTransport => ({
  async read(id) { const r = await send(token, undefined, id); const data = await r.json() as { requests: never[]; error?: string }; if (!r.ok) throw new Error(data.error); return data; },
  async write(body) { const r = await send(token, body); const data = await r.json() as { request: never; error?: string }; if (!r.ok) throw new Error(data.error); return data; },
});

it.each(['reminders', 'reading', 'shared-reading'])('transfers only encrypted browser keys after approval, including retry after a lost response (%s)', async feature => {
  const f = await configure(); const web = transport(feature === 'reading' ? 'reader' : 'app'), mac = transport('vault');
  const app = await requestAppPairing(f.context(feature !== 'reminders'), web, current);
  expect(await app.poll()).toEqual({});
  const pending = (await mac.read()).requests[0]!;
  let lost = true;
  const computer = await answerAppPairing(pending, { ...mac, async write(body) {
    const result = await mac.write(body);
    if (body.action === 'approve' && lost) { lost = false; throw new Error('Response lost'); }
    return result;
  } }, current);
  const appCode = await app.poll(); expect(appCode.payload).toBeUndefined();
  expect(await computer.poll()).toBe(appCode.code);
  expect((await web.read(app.id)).requests[0]!.payload).toBeUndefined();
  const payload = { grants: f.bundle.scopes.map(scope => createReminderKeyGrant(f.bundle, scope.folderPath)) };
  await expect(computer.approve(payload)).rejects.toThrow('Response lost');
  await computer.approve(payload);
  expect((await app.poll()).payload).toEqual(payload);
  const stored = JSON.stringify((await env.DB.prepare("SELECT value FROM maintenance_state WHERE key LIKE 'crate_web_pairing:%'").all()).results);
  for (const secret of [f.recovery, f.bundle.vault.secret, ...f.bundle.scopes.flatMap(s => [s.data.secret, s.notifications.secret])]) expect(stored).not.toContain(secret);
  expect((await transport('other-app').read(app.id)).requests).toEqual([]);
  expect((await send('other-app', { action: 'cancel', id: app.id })).status).toBe(403);
  await app.close(true);
  await expect(app.poll()).rejects.toThrow('ended');
  expect((await mac.read()).requests).toEqual([]);
});

it('admits only enrolled browser scopes and binds attempts to their current folder', async () => {
  const f = await configure(); const request = (await createPairingRequester(f.context())).request;
  expect((await send('capture', { action: 'start', ...request })).status).toBe(403);
  expect((await send('vault', { action: 'start', ...request })).status).toBe(403);
  expect((await send('app', { action: 'start', ...request, context: { ...f.context(), scopeId: crypto.randomUUID() } })).status).toBe(409);
  expect((await send('reader', { action: 'start', ...request })).status).toBe(409);
  await env.DB.prepare("UPDATE reading_policy SET generation='new' WHERE id=1").run();
  expect((await send('reader', { action: 'start', ...(await createPairingRequester(f.context(true))).request })).status).toBe(401);
  await env.DB.prepare('DELETE FROM reading_policy').run();
  expect((await send('app', { action: 'start', ...(await createPairingRequester(f.context(true))).request })).status).toBe(403);
});

it('allows only one responder and refuses changed commitments and replayed approvals', async () => {
  const f = await configure(); const requester = await createPairingRequester(f.context());
  await transport('app').write({ action: 'start', ...requester.request });
  const a = await createPairingResponder(requester.request), b = await createPairingResponder(requester.request);
  const results = await Promise.all([send('vault', { action: 'accept', id: requester.request.context.id, key: a.publicKey }), send('other-vault', { action: 'accept', id: requester.request.context.id, key: b.publicKey })]);
  expect(results.filter(r => r.status === 200)).toHaveLength(1);
  expect(results.filter(r => [403,409].includes(r.status))).toHaveLength(1);
  const attacker = await createPairingResponder(requester.request);
  expect((await send('app', { action: 'reveal', id: requester.request.context.id, key: attacker.publicKey })).status).toBe(409);
  expect((await send('app', { action: 'approve', id: requester.request.context.id, payload: 'invalid' })).status).toBe(403);
});

it.each(['cancel','expire','revoke','generation','reset'] as const)('fences a pending transfer after %s', async reason => {
  const f = await configure(); const web = transport('app'), mac = transport('vault');
  const app = await requestAppPairing(f.context(), web, current);
  const computer = await answerAppPairing((await mac.read()).requests[0]!, mac, current);
  await app.poll(); await computer.poll();
  if (reason === 'cancel') await app.close();
  if (reason === 'expire') await env.DB.prepare("UPDATE maintenance_state SET value=json_set(value,'$.expiresAt',1) WHERE key=?").bind('crate_web_pairing:' + app.id).run();
  if (reason === 'revoke') await env.DB.prepare("DELETE FROM auth_tokens WHERE id='app'").run();
  if (reason === 'generation' || reason === 'reset') await env.DB.prepare("UPDATE maintenance_state SET value=? WHERE key='e2ee:state'").bind(JSON.stringify({ ...f.state, ...(reason === 'generation' ? { generation: 9 } : { mode: 'resetting' }) })).run();
  await expect(computer.approve({ grants: [] })).rejects.toThrow();
  expect((await env.DB.prepare('SELECT value FROM maintenance_state WHERE key=?').bind('crate_web_pairing:' + app.id).first<{ value: string }>())?.value).not.toContain('payload');
});

it('caps attempts without polling writes, including cancelled attempts', async () => {
  const f = await configure(); const web = transport('app');
  for (let n = 0; n < 3; n++) { const app = await requestAppPairing(f.context(), web, current); await app.close(); }
  const before = await env.DB.prepare("SELECT value,updated_at FROM maintenance_state WHERE key LIKE 'crate_web_pairing:%'").all();
  for (let n = 0; n < 5; n++) await transport('vault').read();
  expect((await env.DB.prepare("SELECT value,updated_at FROM maintenance_state WHERE key LIKE 'crate_web_pairing:%'").all()).results).toEqual(before.results);
  expect((await send('app', { action: 'start', ...(await createPairingRequester(f.context())).request })).status).toBe(429);
});

it.each(['start', 'accept'])('retries a lost %s response with the original ephemeral key', async action => {
  const f = await configure();
  const web = transport('app'), mac = transport('vault');
  let lost = false;
  const lossy = (base: PairingTransport): PairingTransport => ({ ...base, async write(body) {
    const result = await base.write(body);
    if (body.action === action && !lost) { lost = true; throw new Error('Response lost'); }
    return result;
  } });
  const app = await requestAppPairing(f.context(), lossy(web), current);
  const computer = await answerAppPairing((await mac.read()).requests[0]!, lossy(mac), current);
  const code = (await app.poll()).code;
  expect(await computer.poll()).toBe(code);
  expect(lost).toBe(true);
  expect((await mac.read()).requests).toHaveLength(1);
});
