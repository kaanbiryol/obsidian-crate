import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { readingRequest } from './api';
import type { ReadingSession } from './session/session';

const encrypted = vi.hoisted(() => vi.fn(async () => ({ deleted: true })));
vi.mock('./session/encryption-session', () => ({
	prepareReadingEncryption: async () => ({ vaultId: 'vault', generation: 1, folderPath: 'Reading', wireFolder: 'tagged-folder', paths: {}, vault: {}, seal: {} }),
	readingEncryptionHeaders: () => ({}),
	readingEncryptionKeys: () => ({ folderPath: 'Reading' }),
	readingNoteFolder: () => 'Reading',
}));
vi.mock('./session/session', async importOriginal => ({ ...await importOriginal<typeof import('./session/session')>(), assertReadingSession: vi.fn() }));
vi.mock('./encrypted-api', async importOriginal => ({ ...await importOriginal<typeof import('./encrypted-api')>(),
	EncryptedReadingApi: class { request = encrypted; } }));

const session: ReadingSession = { id: 'session', token: 'token', generation: 'generation', folderPath: 'tagged-folder', expiresAt: 1 };
const network = vi.fn<typeof fetch>(async () => Response.json({ error: 'Use an unlocked, updated Reading app for this encrypted vault.' }, { status: 428 }));
beforeEach(() => { encrypted.mockClear(); network.mockClear(); vi.stubGlobal('fetch', network); });
afterEach(() => vi.unstubAllGlobals());

it.each(['capture', 'update', 'retry', 'delete'])('sends an encrypted %s only as ciphertext', async action => {
	// Tags, highlights and their notes are private in an encrypted vault.
	const body = JSON.stringify({ id: 'item', before: { tags: ['private'], highlights: [{ start: 0, end: 6, text: 'secret', note: 'mine' }] }, operationId: 'operation' });
	await readingRequest(`/reading/${action}`, session, body);
	expect(encrypted).toHaveBeenCalledWith(`/reading/${action}`, body);
	expect(network).not.toHaveBeenCalled();
});
