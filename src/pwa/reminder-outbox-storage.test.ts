import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearReminderOutbox, createReminderOutboxStorage, createReminderRecoveryStorage } from './reminder-outbox-storage';
import type { PendingReminderChange } from './reminder-outbox-types';

let values: Map<string, string>;
let storage: Storage;

function change(operationId = crypto.randomUUID(), folderPath = 'Reminders'): PendingReminderChange {
	return {
		operationId, kind: 'complete', recordId: 'reminder', status: 'uncertain',
		path: '/reminders/set-completed', method: 'POST', attempts: 1, retryAt: 1000,
		body: JSON.stringify({ operationId, folderPath, id: 'reminder', completed: true,
			filePath: `${folderPath}/Inbox.md`, expectedRevision: 'original-revision' }),
	};
}

describe('durable reminder outbox storage', () => {
	beforeEach(() => {
		values = new Map();
		storage = {
			get length() { return values.size; },
			key: (index: number) => [...values.keys()][index] ?? null,
			getItem: (key: string) => values.get(key) ?? null,
			setItem: (key: string, value: string) => { values.set(key, value); },
			removeItem: (key: string) => { values.delete(key); },
			clear: () => values.clear(),
		};
		vi.stubGlobal('localStorage', storage);
	});
	afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

	it('restores the exact attempted command after reload without storing the token', async () => {
		const original = change();
		original.body = original.body.replace(',', ',\n  ');
		const first = await createReminderOutboxStorage('secret-token', 'Reminders');
		first.put(original);
		const reloaded = await createReminderOutboxStorage('secret-token', 'Reminders');
		expect(reloaded.load()).toEqual([original]);
		expect(JSON.stringify([...values])).not.toContain('secret-token');
	});

	it('isolates both enrolled sessions and reminder folders', async () => {
		const first = await createReminderOutboxStorage('one', 'Reminders');
		const second = await createReminderOutboxStorage('two', 'Reminders');
		const otherFolder = await createReminderOutboxStorage('one', 'Work/Reminders');
		first.put(change());
		second.put(change());
		otherFolder.put(change(crypto.randomUUID(), 'Work/Reminders'));
		expect(first.load()).toHaveLength(1);
		expect(second.load()).toHaveLength(1);
		expect(otherFolder.load()).toHaveLength(1);
		const [firstKey, secondKey] = [...values.keys()];
		expect(first.acceptsKey(firstKey!)).toBe(true);
		expect(first.acceptsKey(secondKey!)).toBe(false);
		expect(first.acceptsKey(null)).toBe(true);
	});

	it('retains unrelated commands when tabs write and remove independently', async () => {
		const first = await createReminderOutboxStorage('one', 'Reminders');
		const second = await createReminderOutboxStorage('one', 'Reminders');
		const a = change();
		const b = change();
		first.put(a);
		second.put(b);
		first.put({ ...a, attempts: 2 });
		expect(second.load()).toEqual([{ ...a, attempts: 2 }, b]);
		second.remove(a.operationId);
		expect(first.load()).toEqual([b]);
	});

	it('keeps enqueue order when status updates happen later', async () => {
		const outbox = await createReminderOutboxStorage('one', 'Reminders');
		const a = change();
		const b = change();
		vi.spyOn(Date, 'now').mockReturnValueOnce(2000).mockReturnValueOnce(3000);
		outbox.put(a);
		outbox.put(b);
		outbox.put({ ...a, attempts: 2, status: 'pending' });
		expect(outbox.load().map(item => item.operationId)).toEqual([a.operationId, b.operationId]);
	});

	it.each(['pending', 'uncertain'] as const)('does not replace %s commands with changed input', async status => {
		const outbox = await createReminderOutboxStorage('one', 'Reminders');
		const original = { ...change(), status };
		outbox.put(original);
		expect(() => outbox.put({ ...original, body: original.body.replace('original-revision', 'new-revision') })).toThrow('cannot be replaced');
		expect(outbox.load()).toEqual([original]);
	});

	it('allows corrected input after a definite rejection with the same operation identity', async () => {
		const outbox = await createReminderOutboxStorage('one', 'Reminders');
		const original = { ...change(), status: 'failed' as const };
		outbox.put(original);
		const corrected = { ...original, status: 'pending' as const,
			body: original.body.replace('original-revision', 'reviewed-revision') };
		outbox.put(corrected);
		expect(outbox.load()).toEqual([corrected]);
		expect(() => outbox.put({ ...corrected, body: corrected.body.replace('reviewed-revision', 'another-revision') })).toThrow('cannot be replaced');
	});

	it('allows a definitely rejected edit to be recovered as a new reminder', async () => {
		const outbox = await createReminderOutboxStorage('one', 'Reminders');
		const original: PendingReminderChange = { ...change(), kind: 'save', path: '/reminders/update', status: 'failed' };
		original.body = JSON.stringify({ operationId: original.operationId, folderPath: 'Reminders', id: original.recordId,
			content: 'Keep my draft', project: 'Inbox' });
		outbox.put(original);
		const restored = { ...original, path: '/reminders/create', recordId: original.operationId,
			status: 'pending' as const, body: original.body.replace('"id":"reminder"', `"id":"${original.operationId}"`) };
		outbox.put(restored);
		expect(outbox.load()).toEqual([restored]);
	});

	it('retains ambiguity across retries and does not allow a later rejection to replace the attempted command', async () => {
		const outbox = await createReminderOutboxStorage('one', 'Reminders');
		const original = { ...change(), ambiguous: true, status: 'failed' as const };
		outbox.put(original);
		expect(() => outbox.put({ ...original, body: original.body.replace('original-revision', 'new-revision') })).toThrow('cannot be replaced');
		expect(() => outbox.put({ ...original, ambiguous: false })).toThrow('cannot be replaced');
		outbox.put({ ...original, status: 'pending', attempts: 0 });
		expect(outbox.load()).toMatchObject([{ ambiguous: true, status: 'pending', body: original.body }]);
	});

	it('preserves the attempted body and later draft as separate durable commands across reload', async () => {
		const original: PendingReminderChange = { ...change(), kind: 'save', path: '/reminders/create', ambiguous: true,
			followUp: { operationId: crypto.randomUUID(), input: { folderPath: 'Reminders', content: 'My later correction',
				description: 'Keep these details', project: 'Inbox', priority: 4, dueDate: null, dueDatetime: null } } };
		original.body = JSON.stringify({ operationId: original.operationId, folderPath: 'Reminders', id: original.recordId,
			content: 'Earlier attempt', project: 'Inbox' });
		const outbox = await createReminderOutboxStorage('one', 'Reminders');
		outbox.put(original);
		expect((await createReminderOutboxStorage('one', 'Reminders')).load()).toEqual([original]);
		expect(() => outbox.put({ ...original, followUp: { ...original.followUp!, operationId: original.operationId } })).toThrow('could not be read');
		expect(() => outbox.put({ ...original, followUp: { ...original.followUp!, input: { ...original.followUp!.input, folderPath: 'Private' } } })).toThrow('could not be read');
		expect(outbox.load()).toEqual([original]);
	});

	it.each(['broken-json', 'wrong-folder', 'wrong-operation', 'wrong-endpoint', 'invalid-ambiguity'])('reports %s without overwriting the stored command', async defect => {
		const outbox = await createReminderOutboxStorage('one', 'Reminders');
		const original = change();
		outbox.put(original);
		const key = [...values.keys()][0]!;
		const raw = values.get(key)!;
		const modified = defect === 'broken-json' ? '{'
			: defect === 'wrong-folder' ? raw.split('Reminders').join('Private')
				: defect === 'wrong-operation' ? raw.split(original.operationId).join(crypto.randomUUID())
					: defect === 'wrong-endpoint' ? raw.replace('/reminders/set-completed', '/auth/session')
						: raw.replace('"status":"uncertain"', '"status":"uncertain","ambiguous":"yes"');
		values.set(key, modified);
		expect(() => outbox.load()).toThrow('could not be read');
		expect(() => outbox.put(original)).toThrow('could not be read');
		expect(values.get(key)).toBe(modified);
	});

	it('surfaces quota failure while preserving the earlier stored state', async () => {
		const outbox = await createReminderOutboxStorage('one', 'Reminders');
		const original = change();
		outbox.put(original);
		vi.spyOn(storage, 'setItem').mockImplementation(() => { throw new DOMException('Full', 'QuotaExceededError'); });
		expect(() => outbox.put(change())).toThrow('Free up storage');
		expect(() => outbox.put({ ...original, attempts: 2 })).toThrow('Free up storage');
		expect(outbox.load()).toEqual([original]);
	});

	it('reports unavailable storage rather than returning an empty queue', async () => {
		vi.stubGlobal('localStorage', undefined);
		await expect(createReminderOutboxStorage('one', 'Reminders')).rejects.toThrow('Could not access');
	});

	it('clears all session queues on logout and leaves unrelated storage alone', async () => {
		(await createReminderOutboxStorage('one', 'Reminders')).put(change());
		(await createReminderOutboxStorage('two', 'Reminders')).put(change());
		values.set('unrelated-setting', 'keep');
		clearReminderOutbox();
		expect([...values]).toEqual([['unrelated-setting', 'keep']]);
	});

	it('requires explicit same-folder recovery after a credential rotates and preserves exact commands', async () => {
		const original = change();
		original.body = original.body.replace(',', ',\n  ');
		original.ambiguous = true;
		const old = await createReminderOutboxStorage('expired-secret', 'Reminders');
		old.put(original);
		const next = await createReminderOutboxStorage('renewed-secret', 'Reminders');
		const recovery = await createReminderRecoveryStorage('renewed-secret', 'Reminders');
		expect(next.load()).toEqual([]);
		expect(recovery.load()).toEqual([original]);
		expect((await createReminderRecoveryStorage('renewed-secret', 'Private')).load()).toEqual([]);
		(await createReminderRecoveryStorage('renewed-secret', 'Private')).adopt();
		expect(old.load()).toEqual([original]);
		recovery.adopt();
		expect(next.load()).toEqual([original]);
		expect(old.load()).toEqual([]);
		expect(recovery.load()).toEqual([]);
		expect(JSON.stringify([...values])).not.toMatch(/expired-secret|renewed-secret/);
	});

	it('preserves old work when adoption hits quota and completes an interrupted copy without duplication', async () => {
		const old = await createReminderOutboxStorage('old', 'Reminders');
		const next = await createReminderOutboxStorage('next', 'Reminders');
		const recovery = await createReminderRecoveryStorage('next', 'Reminders');
		const original = change();
		old.put(original);
		const write = vi.spyOn(storage, 'setItem').mockImplementationOnce(() => { throw new DOMException('Full', 'QuotaExceededError'); });
		expect(() => recovery.adopt()).toThrow('Free up storage');
		expect(old.load()).toEqual([original]);
		expect(next.load()).toEqual([]);
		write.mockRestore();
		// A crash after the destination copy, before deleting the source.
		next.put(original);
		recovery.adopt();
		expect(next.load()).toEqual([original]);
		expect(old.load()).toEqual([]);
		clearReminderOutbox();
		expect(next.load()).toEqual([]);
		expect(recovery.load()).toEqual([]);
	});
});
