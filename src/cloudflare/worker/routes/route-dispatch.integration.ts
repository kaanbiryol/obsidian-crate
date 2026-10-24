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
import { commitNewFiles } from '../sync/bulk-new-file-commit';
import type { AuthPrincipal } from '../auth/authenticate';
import { createEncryptionFixture, storeEncryptionState } from '../test-support/encryption-test-harness';
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
		const scope = apiRoutePolicy(path, method)!.scopes[0]!;
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

it('serves shared settings from the store that matches the vault encryption', async () => {
	const read = async () => (await handleAuthenticatedRoute(new Request('https://worker.test/settings'), env, {
		uploadCommitters: { commitUpload: commitStagedFile, commitNewFiles }, path: '/settings', method: 'GET',
		principal: { tokenId: 'route-dispatch', scope: 'vault' }, resetGeneration: null, encryption: null,
	}))!.json() as Promise<unknown>;
	// An unreadable plaintext record still reports its R2 version.
	const plaintext = (await env.BUCKET.put('__crate__/settings.json', 'unreadable'))!;
	expect(await read()).toEqual({ settings: null, settingsVersion: plaintext.etag });
	await storeEncryptionState(env.DB, (await createEncryptionFixture('active')).state);
	expect(await read()).toEqual({ settings: null, settingsVersion: null });
});

it('serves every public asset admitted before authentication', async () => {
	for (const path of PUBLIC_ASSET_PATHS) {
		expect(await handlePublicRoute(new Request(`https://worker.test${path}`), env, path, 'GET'), path).not.toBeNull();
	}
});
