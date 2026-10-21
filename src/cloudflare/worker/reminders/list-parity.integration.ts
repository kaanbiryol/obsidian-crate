/// <reference types="@cloudflare/vitest-plugin/types" />
import { afterEach, beforeEach, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import { applySchema } from '../test-support/schema-test-harness';
import { handleListReminders } from './routes/list';
import { writeCommittedMarkdownFile } from '../storage';
import { addReminderScope, createVaultKeyBundle } from '@/encryption/key-bundle';
import { importEncryptionSecret } from '@/encryption/envelope';
import { importNotificationFingerprintKey } from '@/encryption/reminder-projection';
import { sealFile } from '@/encryption/file-codec';
import { EncryptedReminderApi } from '@/pwa/reminders/encrypted-reminder-api';
import { REMINDER_IDENTITY_CONFLICT_ISSUE } from '@/reminders/core/reminder-list';

// The Worker index and the encrypted web app build their lists with one shared
// rule, so the same notes give the same reminders, projects and issues.
const notes: Record<string, string> = {
	'Inbox.md': '- [ ] First <!-- crate-id:first -->\n- [ ] Copy <!-- crate-id:shared -->\n- [ ] Copy again <!-- crate-id:shared -->\n',
	'Zeta.md': '- [x] Done <!-- crate-id:done -->\n',
	'apple.md': '# Apple\n',
	'work.md': '- [ ] Copy <!-- crate-id:shared -->\n- [ ] Work task <!-- crate-id:work -->\n',
	'Été.md': '- [ ] Summer task <!-- crate-id:summer -->\n',
};

beforeEach(async () => { await applySchema(env.DB); });
afterEach(async () => { await reset(); });

async function listPlaintext(): Promise<unknown> {
	for (const [name, content] of Object.entries(notes)) await writeCommittedMarkdownFile(env.BUCKET, env.DB, `Reminders/${name}`, content, null);
	const response = await handleListReminders(new Request('https://worker.test/reminders/list?folderPath=Reminders'), env);
	expect(response.status).toBe(200);
	return response.json();
}

async function listEncrypted(remoteFolder: string): Promise<unknown> {
	const bundle = addReminderScope(createVaultKeyBundle(), remoteFolder), scope = bundle.scopes[0]!;
	const keys = { version: 1 as const, vaultId: bundle.vaultId, scopeId: scope.id, folderPath: scope.folderPath, localFolderPath: 'Reminders',
		generation: bundle.generation, data: await importEncryptionSecret(scope.data), notifications: await importEncryptionSecret(scope.notifications),
		notificationFingerprint: await importNotificationFingerprintKey(bundle.vaultId, scope), localState: 'unused' };
	const authority = { vaultId: keys.vaultId, scopeId: keys.scopeId, key: keys.data };
	const sealed = await Promise.all(Object.entries(notes).map(async ([name, content]) => {
		const path = `${remoteFolder}/${name}`;
		return { path, sealed: await sealFile({ path, content: new TextEncoder().encode(content), contentType: 'text/markdown', publicData: { version: 1, reminders: [] } }, authority) };
	}));
	const files = sealed.map(({ path, sealed }) => ({ path, hash: sealed.hash, size: sealed.bytes.length, revision: sealed.hash }));
	const fetch = async (route: string) => {
		if (!route.startsWith('/reminders/encrypted-file?')) return Response.json({ files, sequence: 1, generation: keys.generation, nextCursor: null });
		const revision = new URL(route, 'https://worker.test').searchParams.get('revision');
		return new Response(sealed.find(note => note.sealed.hash === revision)!.sealed.bytes);
	};
	const response = await new EncryptedReminderApi(keys, fetch).handle('/reminders/list?folderPath=Reminders');
	expect(response?.status).toBe(200);
	return response!.json();
}

it.each(['Reminders', 'Vault/Tasks'])('lists the same reminders, projects and issues as the encrypted web app (remote folder %s)', async remoteFolder => {
	const plaintext = await listPlaintext();
	expect(plaintext).toMatchObject({
		reminders: ['first', 'done', 'work', 'summer'].map(id => ({ id })),
		projects: ['apple', 'Été', 'Inbox', 'work', 'Zeta'],
		issues: [
			{ path: 'Reminders/Inbox.md', reason: REMINDER_IDENTITY_CONFLICT_ISSUE },
			{ path: 'Reminders/work.md', reason: REMINDER_IDENTITY_CONFLICT_ISSUE },
		],
	});
	expect(await listEncrypted(remoteFolder)).toEqual(plaintext);
});
