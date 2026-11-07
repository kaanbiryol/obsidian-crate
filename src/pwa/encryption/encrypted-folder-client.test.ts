import { expect, it, vi } from 'vitest';
import { encryptedOperationContext, postEncryptedCommit } from './encrypted-folder-client';

it('keeps the wire purpose of operation acknowledgments', () => {
	expect(encryptedOperationContext('vault-a', 'vault', 'operation-1')).toEqual({ vaultId: 'vault-a', scopeId: 'vault', objectId: 'operation-1', purpose: 'reminder' });
});

it('sends the stored attempt and tells a version conflict from other failures', async () => {
	const send = vi.fn<(path: string, body: string) => Promise<Response>>();
	send.mockResolvedValueOnce(Response.json({ encrypted: 'sealed-receipt' }));
	await expect(postEncryptedCommit(send, '/reading', '{"exact":"bytes"}')).resolves.toEqual({ kind: 'committed', encrypted: 'sealed-receipt' });
	expect(send).toHaveBeenCalledWith('/reading/encrypted-commit', '{"exact":"bytes"}');

	send.mockResolvedValueOnce(Response.json({ error: 'Note changed', code: 'version_conflict' }, { status: 409 }));
	const conflict = await postEncryptedCommit(send, '/reminders', 'body');
	expect(conflict).toMatchObject({ kind: 'conflict', answer: { error: 'Note changed', code: 'version_conflict' } });
	// The response itself stays unread, so a caller can return it as it came.
	expect(conflict.kind === 'conflict' && await conflict.response.json()).toEqual({ error: 'Note changed', code: 'version_conflict' });
	expect(send).toHaveBeenLastCalledWith('/reminders/encrypted-commit', 'body');

	send.mockResolvedValueOnce(Response.json({ error: 'Folder moved', code: 'scope_mismatch' }, { status: 409 }));
	const failed = await postEncryptedCommit(send, '/reminders', 'body');
	expect(failed).toMatchObject({ kind: 'failed', response: { status: 409, bodyUsed: false } });

	send.mockResolvedValueOnce(Response.json({ error: 'Not confirmed' }));
	await expect(postEncryptedCommit(send, '/reading', 'body')).resolves.toMatchObject({ kind: 'failed', answer: { error: 'Not confirmed' } });
});
