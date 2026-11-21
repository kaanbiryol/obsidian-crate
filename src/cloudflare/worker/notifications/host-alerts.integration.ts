/// <reference types="@cloudflare/vitest-plugin/types" />
import { afterEach, beforeEach, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import { applySchema } from '../test-support/schema-test-harness';
import { sendHostAlert } from '../coordinator/coordinator';
import { fetchWorkerRequest } from '../request-handler';
import { sha256Hex } from '@/platform/sha256';
import { CRATE_PLUGIN_PROTOCOL } from '../../../protocol/server-info';
import { HOST_STATUS_KEY, HOST_STATUS_PATH } from '../../../protocol/host-status';
import { HOST_ALERTS } from './host-alerts';

beforeEach(async () => {
	await applySchema(env.DB);
	await env.DB.prepare("INSERT INTO auth_tokens (id, token_hash, scope) VALUES ('device', ?, 'vault'), ('phone', ?, 'reminders')")
		.bind(await sha256Hex('vault-token'), await sha256Hex('reminders-token')).run();
});
afterEach(async () => { await reset(); });

const read = (token: string) => fetchWorkerRequest(new Request(`https://crate.test${HOST_STATUS_PATH}`, {
	headers: { Authorization: `Bearer ${token}`, 'X-Crate-Protocol': String(CRATE_PLUGIN_PROTOCOL.current) },
}), env);

it('serves the host status to vault devices only, and none on a server without a host process', async () => {
	expect(await (await read('vault-token')).json()).toEqual({ host: null });
	const host = { install: 'docker', startedAt: '2026-11-21T09:00:00.000Z', lastBackupAt: null, autoBackup: { on: true, lastFailureAt: '2026-11-21T10:00:00Z' },
		publicAccess: 'waiting', diskFreeBytes: 1024, path: '/data/server' };
	await env.DB.prepare('INSERT INTO maintenance_state(key, value) VALUES (?, ?)').bind(HOST_STATUS_KEY, JSON.stringify(host)).run();
	const { path: _path, ...served } = host;
	expect(await (await read('vault-token')).json()).toEqual({ host: served });
	expect((await read('reminders-token')).status).toBe(403);
	await env.DB.prepare('UPDATE maintenance_state SET value = ? WHERE key = ?').bind('{not json', HOST_STATUS_KEY).run();
	expect(await (await read('vault-token')).json()).toEqual({ host: null });
});

it('pushes a known host alert through the dispatcher and rejects others', async () => {
	expect(Object.keys(HOST_ALERTS)).toEqual(['backup-failed', 'public-access-lost', 'low-disk']);
	// No browser has enrolled for push, so there is nobody to send to.
	expect(await sendHostAlert(env, 'backup-failed')).toBe(0);
	await expect(sendHostAlert(env, 'unknown')).rejects.toThrow('400');
});
