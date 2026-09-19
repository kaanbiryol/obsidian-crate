/// <reference types="@cloudflare/vitest-plugin/types" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import schema from '../schema.sql?raw';
import worker from './index';
import { sha256HexBytes } from './auth';

beforeEach(async () => {
	for (const sql of schema.split(';').map(value => value.trim()).filter(Boolean)) await env.DB.prepare(sql).run();
	for (const scope of ['vault', 'reminders']) {
		await env.DB.prepare('INSERT INTO auth_tokens (id, token_hash, scope, folder_path, expires_at) VALUES (?, ?, ?, ?, ?)')
			.bind(scope, await sha256HexBytes(new TextEncoder().encode(`${scope}-credential`)), scope, scope === 'reminders' ? 'Reminders' : null, Date.now() + 60000).run();
	}
});
afterEach(async () => { vi.restoreAllMocks(); await reset(); });
function request(token?: string, method = 'POST', body = JSON.stringify({ url: 'https://example.com/article#private' })) {
	return new Request('https://crate.test/links/title', { method, ...(method === 'GET' ? {} : { body }), headers: token ? { Authorization: `Bearer ${token}` } : {} });
}
const mockPage = () => vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('<title>Public article</title>', { headers: { 'Content-Type': 'text/html' } }));

describe('authenticated page titles in the Worker runtime', () => {
	it.each(['vault', 'reminders'])('serves %s credentials without a mutation protocol or folder body', async scope => {
		const outbound = mockPage();
		const response = await worker.fetch(request(`${scope}-credential`), env);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ title: 'Public article' });
		expect(response.headers.get('Cache-Control')).toBe('private, no-store');
		expect(response.headers.get('X-Crate-Request-Id')).toBeTruthy();
		expect(outbound).toHaveBeenCalledWith('https://example.com/article', expect.objectContaining({ headers: { Accept: 'text/html' } }));
		for (const table of ['files', 'changelog', 'reminder_operations']) {
			expect(await env.DB.prepare(`SELECT COUNT(*) AS count FROM ${table}`).first()).toEqual({ count: 0 });
		}
	});
	it.each([undefined, 'unknown-credential'])('denies unauthenticated lookups (%s) without network activity', async token => {
		const outbound = mockPage();
		expect((await worker.fetch(request(token), env)).status).toBe(401);
		expect(outbound).not.toHaveBeenCalled();
	});
	it('denies expired and revoked sessions before fetching', async () => {
		const outbound = mockPage();
		await env.DB.prepare("UPDATE auth_tokens SET expires_at = 1 WHERE id = 'reminders'").run();
		expect((await worker.fetch(request('reminders-credential'), env)).status).toBe(401);
		await env.DB.prepare("DELETE FROM auth_tokens WHERE id = 'vault'").run();
		expect((await worker.fetch(request('vault-credential'), env)).status).toBe(401);
		expect(outbound).not.toHaveBeenCalled();
	});
	it('does not authorize other methods for reminder sessions', async () => {
		const outbound = mockPage();
		expect((await worker.fetch(request('reminders-credential', 'GET'), env)).status).toBe(403);
		expect(outbound).not.toHaveBeenCalled();
	});
	it('applies a separate authenticated rate limit before fetching', async () => {
		const outbound = mockPage();
		const limit = vi.fn().mockResolvedValue({ success: false });
		const response = await worker.fetch(request('reminders-credential'), { ...env, NOTIFICATION_REQUEST_LIMITER: { limit } });
		expect(response.status).toBe(429);
		expect(response.headers.get('Retry-After')).toBe('60');
		expect(limit).toHaveBeenCalledWith({ key: 'link-titles:reminders' });
		expect(outbound).not.toHaveBeenCalled();
	});
	it('rejects malformed and private destinations through the real route', async () => {
		const outbound = mockPage();
		for (const body of ['{', JSON.stringify({ url: 'http://127.1' })]) {
			expect((await worker.fetch(request('vault-credential', 'POST', body), env)).status).toBe(400);
		}
		expect(outbound).not.toHaveBeenCalled();
	});
});
