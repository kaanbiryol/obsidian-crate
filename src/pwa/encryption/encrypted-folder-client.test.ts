import { expect, it, vi } from 'vitest';
import { commitEncryptedAttempt, encryptedOperationContext, postEncryptedCommit, type EncryptedCommitOutcome } from './encrypted-folder-client';

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

it('treats a non-JSON 409, such as a proxy page, as a failure with its body unread', async () => {
	const send = vi.fn<(path: string, body: string) => Promise<Response>>();
	send.mockResolvedValueOnce(new Response('<html>Conflict</html>', { status: 409, headers: { 'content-type': 'text/html' } }));
	const failed = await postEncryptedCommit(send, '/reminders', 'body');
	expect(failed).toMatchObject({ kind: 'failed', response: { status: 409, bodyUsed: false } });
	expect(failed.kind === 'failed' && failed.answer).toBe(undefined);
});

interface Stored { body: string; rejected?: boolean }

it('rebuilds a conflicting attempt once and settles a second conflict', async () => {
	const conflict = () => Response.json({ error: 'Note changed', code: 'version_conflict' }, { status: 409 });
	const send = vi.fn<(path: string, body: string) => Promise<Response>>().mockImplementation(async () => conflict());
	const rejected: Stored[] = [];
	let builds = 0;
	const settle = vi.fn(async (outcome: EncryptedCommitOutcome) => outcome.kind);
	await expect(commitEncryptedAttempt(send, '/reading', { body: 'saved' }, {
		build: async () => ({ attempt: { body: `built-${++builds}` } }),
		reject: async attempt => { rejected.push(attempt); },
		settle,
	})).resolves.toBe('conflict');
	// The saved attempt is sent as is, then rebuilt once; a rejected attempt is never resent.
	expect(send.mock.calls.map(([, body]) => body)).toEqual(['saved', 'built-1']);
	expect(rejected).toEqual([{ body: 'saved', rejected: true }, { body: 'built-1', rejected: true }]);
	expect(settle).toHaveBeenCalledOnce();
});

it('builds a missing or rejected attempt, and lets the build answer without committing', async () => {
	const send = vi.fn<(path: string, body: string) => Promise<Response>>().mockImplementation(async () => Response.json({ encrypted: 'receipt' }));
	const steps = {
		build: vi.fn(async () => ({ attempt: { body: 'built' } })),
		reject: vi.fn(async () => {}),
		settle: vi.fn(async (outcome: EncryptedCommitOutcome, attempt: { body: string }) => outcome.kind === 'committed' && `${outcome.encrypted}:${attempt.body}`),
	};
	await expect(commitEncryptedAttempt<Stored, unknown>(send, '/reminders', { body: 'old', rejected: true }, steps)).resolves.toBe('receipt:built');
	expect(steps.build).toHaveBeenCalledWith({ body: 'old', rejected: true });
	expect(send).toHaveBeenCalledWith('/reminders/encrypted-commit', 'built');
	await expect(commitEncryptedAttempt<Stored, unknown>(send, '/reading', undefined, { ...steps, build: async () => ({ response: 'already saved' }) })).resolves.toBe('already saved');
	expect(send).toHaveBeenCalledOnce();
	expect(steps.reject).not.toHaveBeenCalled();
});
