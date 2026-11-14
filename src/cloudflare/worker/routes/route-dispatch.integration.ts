/// <reference types="@cloudflare/vitest-plugin/types" />
import { afterEach, beforeEach, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import { applySchema } from '../test-support/schema-test-harness';
import { apiRoutePolicy, apiRoutes } from './policy';
import { PUBLIC_ASSET_PATHS } from './admission';
import { handleAuthenticatedRoute, handlePublicRoute } from '../router';
import { updatePolicy } from '../reading/access';
import { policy } from '../reading/common';
import { commitStagedFile } from '../sync/mutations';
import { commitNewFiles } from '../sync/staging/bulk-new-file-commit';
import type { AuthPrincipal } from '../auth/authenticate';
import type { EncryptionServerState } from '../../../encryption/server-state';
import { createEncryptionFixture } from '../test-support/encryption-test-harness';
import { CRATE_PLUGIN_PROTOCOL, CRATE_PROTOCOL_HEADER } from '@/protocol/server-info';

beforeEach(async () => {
	await applySchema(env.DB);
	// Reading handlers check their folder before matching the path.
	await updatePolicy(env.DB, { enabled: false, folderPath: 'Reading', revision: null });
});
afterEach(async () => { await reset(); });

/** The router's unmatched result and Reading's own catch-all response. */
async function fellThrough(response: Response | null): Promise<boolean> {
	if (!response) return true;
	if (response.status !== 404) return false;
	const body: unknown = await response.clone().json().catch(() => null);
	return typeof body === 'object' && body !== null && (body as { error?: unknown }).error === 'Not found';
}

it('dispatches every declared API route to a handler', async () => {
	const reading = (await policy(env.DB))!;
	const unhandled: string[] = [];
	for (const { method, path } of apiRoutes()) {
		// Public routes answer before any principal is consulted.
		const scope = apiRoutePolicy(path, method)!.scopes[0] ?? 'vault';
		const principal: AuthPrincipal = scope === 'vault' ? { tokenId: 'route-dispatch', scope }
			: { tokenId: 'route-dispatch', scope, folderPath: reading.folder_path, readingGeneration: reading.generation };
		const request = new Request(`https://worker.test${path}`, {
			method,
			headers: { 'Content-Type': 'application/json', [CRATE_PROTOCOL_HEADER]: String(CRATE_PLUGIN_PROTOCOL.current) },
			body: method === 'GET' ? undefined : '{}',
		});
		let response: Response | null;
		try {
			response = await handlePublicRoute(request, env, path, method) ?? await handleAuthenticatedRoute(request, env, {
				uploadCommitters: { commitUpload: commitStagedFile, commitNewFiles }, path, method, principal,
				resetGeneration: null, encryption: null,
			});
		} catch {
			// Handlers match their path before validating; a rejection means one was reached.
			continue;
		}
		if (await fellThrough(response)) unhandled.push(`${method} ${path}`);
	}
	expect(unhandled).toEqual([]);
});

it('serves shared settings for the encryption state authentication loaded', async () => {
	// The route uses the encryption state authentication loaded with the token.
	const read = async (encryption: EncryptionServerState | null) => (await handleAuthenticatedRoute(new Request('https://worker.test/settings'), env, {
		uploadCommitters: { commitUpload: commitStagedFile, commitNewFiles }, path: '/settings', method: 'GET',
		principal: { tokenId: 'route-dispatch', scope: 'vault' }, resetGeneration: null, encryption,
	}))!.json() as Promise<unknown>;
	expect(await read(null)).toEqual({ settings: null, settingsVersion: null });
	const sealed = { version: 1, vaultId: 'vault', keyId: 'key', envelope: 'opaque' };
	await env.DB.prepare('INSERT INTO server_state(id, settings, settings_version) VALUES (1, ?, ?)').bind(JSON.stringify(sealed), 'stored').run();
	// A sealed record is returned as stored; a plaintext reader finds no valid settings in it.
	const { state } = await createEncryptionFixture('active');
	expect(await read(state)).toEqual({ settings: sealed, settingsVersion: 'stored' });
	expect(await read(null)).toEqual({ settings: null, settingsVersion: 'stored' });
});

it('answers before authentication exactly the API routes declared public', async () => {
	const mismatched: string[] = [];
	for (const { method, path } of apiRoutes()) {
		let answered: boolean;
		try { answered = await handlePublicRoute(new Request(`https://worker.test${path}`, { method }), env, path, method) !== null; }
		catch { answered = true; }
		if (answered !== Boolean(apiRoutePolicy(path, method)?.public)) mismatched.push(`${method} ${path}`);
	}
	expect(mismatched).toEqual([]);
});

it('serves every public asset admitted before authentication', async () => {
	for (const path of PUBLIC_ASSET_PATHS) {
		expect(await handlePublicRoute(new Request(`https://worker.test${path}`), env, path, 'GET'), path).not.toBeNull();
	}
});
