import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createReminderOutbox } from './reminder-outbox';
import { followUpReminderChange } from './save-reminder-command';
import type { ReminderOutboxStorage } from './reminder-outbox-storage';
import type { PendingReminderChange, ReminderChangeResult } from './reminder-outbox-types';
import type { ReminderRecord } from './types';

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
	return { promise, resolve, reject };
}

function reminder(id = 'one'): ReminderRecord {
	return { id, content: `Task ${id}`, revision: `revision-${id}`, project: 'Inbox',
		filePath: 'Reminders/Inbox.md', priority: 4, completed: false };
}

function completion(id = 'one'): PendingReminderChange {
	const previous = reminder(id);
	const operationId = crypto.randomUUID();
	return { operationId, kind: 'complete', recordId: id, previous,
		optimistic: { ...previous, completed: true }, status: 'pending', attempts: 0, retryAt: 0,
		path: '/reminders/set-completed', method: 'POST',
		body: JSON.stringify({ operationId, id, folderPath: 'Reminders', filePath: previous.filePath,
			expectedRevision: previous.revision, completed: true }) };
}

function save(): PendingReminderChange {
	const change = completion();
	return { ...change, kind: 'save', path: '/reminders/create', previous: undefined,
		optimistic: { ...reminder(), content: 'My draft', description: 'Preserve these details' },
		body: JSON.stringify({ operationId: change.operationId, id: change.recordId, folderPath: 'Reminders',
			content: 'My draft', description: 'Preserve these details', project: 'Inbox' }),
		modal: { mode: 'create', operationId: change.operationId, draft: { content: 'My draft',
			description: 'Preserve these details', project: 'Inbox', defaultProject: 'Inbox', priority: 4,
			dueDate: '', dueTime: '', activePicker: null, deleteConfirm: false } } };
}

function saveWithFollowUp(): PendingReminderChange {
	return { ...save(), ambiguous: true, followUp: { operationId: crypto.randomUUID(), input: {
		folderPath: 'Reminders', content: 'My later correction', description: 'Preserved detail', project: 'Inbox',
		priority: 4, dueDate: null, dueDatetime: null,
	} } };
}

function memoryStorage() {
	const entries = new Map<string, PendingReminderChange>();
	const storage: ReminderOutboxStorage = {
		load: () => structuredClone([...entries.values()]),
		put: change => { entries.set(change.operationId, structuredClone(change)); },
		remove: id => { entries.delete(id); },
		acceptsKey: () => true,
	};
	return storage;
}

function harness(storage = memoryStorage(), withLock?: (work: () => Promise<void>) => Promise<void>, canSend?: () => boolean) {
	let current = true;
	const requests: Array<ReturnType<typeof deferred<Response>> & { path: string; init?: RequestInit }> = [];
	const apiFetch = vi.fn((path: string, init?: RequestInit) => {
		const request = { ...deferred<Response>(), path, init };
		requests.push(request);
		return request.promise;
	});
	const commit = vi.fn(async (_change: PendingReminderChange, _result: ReminderChangeResult): Promise<PendingReminderChange | void> => {});
	const finish = vi.fn();
	const beginMutation = vi.fn(() => finish);
	const onChange = vi.fn();
	const onError = vi.fn();
	const onSettled = vi.fn();
	const outbox = createReminderOutbox({ storage, apiFetch, withLock, canSend, isCurrent: () => current,
		beginMutation, commit, onChange, onError, onSettled });
	return { ...outbox, storage, requests, apiFetch, commit, beginMutation, finish, onChange, onError, onSettled,
		invalidate: () => { current = false; } };
}

function confirmed(id = 'one') {
	return new Response(JSON.stringify({ success: true, reminder: { ...reminder(id), completed: true, revision: 'confirmed-revision' } }));
}

beforeEach(() => vi.stubGlobal('navigator', { onLine: true }));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('optimistic reminder outbox', () => {
	it('stops expired ambiguous commands for review while healthy work continues and requires the exact exported change to remove them', async () => {
		const locks = vi.fn(async (work: () => Promise<void>) => work());
		const state = harness(memoryStorage(), locks);
		const expired = { ...completion(), status: 'uncertain' as const, ambiguous: true };
		const healthy = completion('two');
		state.storage.put(expired); state.storage.put(healthy);
		const draining = state.drain();
		state.requests[0]!.resolve(new Response(JSON.stringify({ code: 'operation_expired', error: 'Export and compare current reminders.' }), { status: 410 }));
		await vi.waitFor(() => expect(state.requests).toHaveLength(2));
		state.requests[1]!.resolve(confirmed('two'));
		await draining;
		const retained = state.storage.load()[0]!;
		expect(retained).toMatchObject({ body: expired.body, operationId: expired.operationId, status: 'failed', ambiguous: true, reviewRequired: true });
		state.retry(expired.operationId); await state.drain();
		expect(state.requests).toHaveLength(2);
		await state.discard(expired.operationId);
		await state.discard(expired.operationId, expired.body);
		expect(state.storage.load()).toHaveLength(1);
		const exported = JSON.stringify(retained);
		state.storage.put({ ...retained, error: 'Another tab changed the saved entry' });
		await state.discard(expired.operationId, exported);
		expect(state.storage.load()).toHaveLength(1);
		await state.discard(expired.operationId, JSON.stringify(state.storage.load()[0]));
		expect(state.storage.load()).toEqual([]);
		expect(locks).toHaveBeenCalled();
	});
	it('persists before exposing the optimistic change and waits for confirmation before committing', async () => {
		const state = harness();
		const change = completion();
		state.onChange.mockImplementation(() => { expect(state.storage.load()).toHaveLength(1); });
		state.enqueue(change);
		expect(state.storage.load()).toEqual([change]);
		expect(state.onChange).toHaveBeenCalledWith([change]);
		expect(state.apiFetch).not.toHaveBeenCalled();
		state.onChange.mockReset();
		const draining = state.drain();
		expect(state.requests).toHaveLength(1);
		expect(state.storage.load()[0]?.attempts).toBe(1);
		expect(state.commit).not.toHaveBeenCalled();
		state.requests[0]!.resolve(confirmed());
		await draining;
		expect(state.commit).toHaveBeenCalledOnce();
		expect(state.storage.load()).toEqual([]);
		expect(state.finish).toHaveBeenCalledOnce();
		expect(state.onSettled).toHaveBeenCalledOnce();
	});

	it('keeps the durable command until the confirmed state has finished persisting', async () => {
		const state = harness();
		const commitFinished = deferred<void>();
		state.commit.mockImplementation(() => commitFinished.promise);
		state.enqueue(completion());
		const draining = state.drain();
		state.requests[0]!.resolve(confirmed());
		await vi.waitFor(() => expect(state.commit).toHaveBeenCalledOnce());
		expect(state.storage.load()).toHaveLength(1);
		commitFinished.resolve();
		await draining;
		expect(state.storage.load()).toEqual([]);
	});

	it('retains the exact idempotent command when publishing confirmation fails', async () => {
		const state = harness();
		const original = completion();
		state.commit.mockRejectedValueOnce(new Error('Could not share the confirmed change'));
		state.enqueue(original);
		const first = state.drain();
		state.requests[0]!.resolve(confirmed());
		await first;
		expect(state.storage.load()).toMatchObject([{ operationId: original.operationId, body: original.body, status: 'uncertain', ambiguous: true }]);
		state.retry(original.operationId);
		const retry = state.drain();
		expect(state.requests[1]?.init).toEqual(state.requests[0]?.init);
		state.requests[1]!.resolve(confirmed());
		await retry;
		expect(state.storage.load()).toEqual([]);
	});

	it('persists and sends a later draft only after the original receipt supplies its revision', async () => {
		const state = harness();
		const original = saveWithFollowUp();
		state.commit.mockImplementation(async (change, result) => result.reminder ? followUpReminderChange(change, result.reminder) : undefined);
		state.enqueue(original);
		const remove = state.storage.remove.bind(state.storage);
		vi.spyOn(state.storage, 'remove').mockImplementation(id => {
			if (id === original.operationId) expect(state.storage.load().some(change => change.operationId === original.followUp!.operationId)).toBe(true);
			remove(id);
		});
		const draining = state.drain();
		expect(state.requests).toHaveLength(1);
		expect(state.requests[0]?.init?.body).toBe(original.body);
		state.requests[0]!.resolve(confirmed());
		await vi.waitFor(() => expect(state.requests).toHaveLength(2));
		expect(state.requests[1]?.path).toBe('/reminders/update');
		expect(JSON.parse(state.requests[1]?.init?.body as string)).toMatchObject({
			id: original.recordId, operationId: original.followUp!.operationId,
			expectedRevision: 'confirmed-revision', content: 'My later correction',
		});
		expect(state.storage.load()).toMatchObject([{ operationId: original.followUp!.operationId }]);
		state.requests[1]!.resolve(confirmed());
		await draining;
		expect(state.storage.load()).toEqual([]);
	});

	it('retains original receipt and later intent when storing the successor fails', async () => {
		const state = harness();
		const original = saveWithFollowUp();
		state.commit.mockImplementation(async (change, result) => result.reminder ? followUpReminderChange(change, result.reminder) : undefined);
		state.enqueue(original);
		const put = state.storage.put.bind(state.storage);
		const blockedWrite = vi.spyOn(state.storage, 'put').mockImplementation(change => {
			if (change.operationId === original.followUp!.operationId) throw new Error('Storage is full');
			put(change);
		});
		const first = state.drain();
		state.requests[0]!.resolve(confirmed());
		await first;
		expect(state.requests).toHaveLength(1);
		expect(state.storage.load()).toMatchObject([{ operationId: original.operationId, body: original.body,
			status: 'uncertain', ambiguous: true, followUp: original.followUp }]);
		blockedWrite.mockRestore();
		state.retry(original.operationId);
		const retry = state.drain();
		expect(state.requests[1]?.init).toEqual(state.requests[0]?.init);
		state.requests[1]!.resolve(confirmed());
		await vi.waitFor(() => expect(state.requests).toHaveLength(3));
		expect(JSON.parse(state.requests[2]?.init?.body as string)).toMatchObject({ operationId: original.followUp!.operationId,
			expectedRevision: 'confirmed-revision', content: 'My later correction' });
		state.requests[2]!.resolve(confirmed());
		await retry;
		expect(state.storage.load()).toEqual([]);
	});

	it('waits for the initial confirmed snapshot before replaying durable changes', async () => {
		let snapshotReady = false;
		const state = harness(memoryStorage(), undefined, () => snapshotReady);
		const change = completion();
		state.enqueue(change);
		await state.drain();
		expect(state.requests).toEqual([]);
		expect(state.storage.load()).toEqual([change]);
		snapshotReady = true;
		const draining = state.drain();
		state.requests[0]!.resolve(confirmed());
		await draining;
		expect(state.storage.load()).toEqual([]);
	});

	it('serializes different reminders in one file and lets another succeed after a rejection', async () => {
		const state = harness();
		const first = completion('one');
		const second = completion('two');
		state.enqueue(first);
		state.enqueue(second);
		const draining = state.drain();
		await state.drain();
		expect(state.requests).toHaveLength(1);
		state.requests[0]!.resolve(new Response(JSON.stringify({ error: 'Changed elsewhere', code: 'version_conflict' }), { status: 409 }));
		await vi.waitFor(() => expect(state.requests).toHaveLength(2));
		expect(state.storage.load()).toMatchObject([{ operationId: first.operationId, status: 'failed' }, { operationId: second.operationId, status: 'pending' }]);
		state.requests[1]!.resolve(confirmed('two'));
		await draining;
		expect(state.commit).toHaveBeenCalledOnce();
		expect(state.commit.mock.calls[0]?.[0].recordId).toBe('two');
		expect(state.storage.load()).toMatchObject([{ operationId: first.operationId, status: 'failed' }]);
	});

	it('retries a timed-out request using the exact body and operation identity', async () => {
		const state = harness();
		const change = completion();
		state.enqueue(change);
		const first = state.drain();
		state.requests[0]!.reject(new Error('Timed out after server commit'));
		await first;
		expect(state.storage.load()).toMatchObject([{ operationId: change.operationId, status: 'uncertain', body: change.body }]);
		state.retry(change.operationId);
		const retry = state.drain();
		expect(state.requests[1]?.init).toEqual(state.requests[0]?.init);
		state.requests[1]!.resolve(confirmed());
		await retry;
		expect(state.storage.load()).toEqual([]);
	});

	it('replays an in-flight persisted command after reload', async () => {
		const before = harness();
		const change = completion();
		before.enqueue(change);
		const abandoned = before.drain();
		before.invalidate();
		const after = harness(before.storage);
		const retry = after.drain();
		expect(after.requests[0]?.init).toEqual(before.requests[0]?.init);
		after.requests[0]!.resolve(confirmed());
		await retry;
		before.requests[0]!.resolve(confirmed());
		await abandoned;
		expect(before.commit).not.toHaveBeenCalled();
		expect(after.commit).toHaveBeenCalledOnce();
		expect(after.storage.load()).toEqual([]);
	});

	it('does not reinterpret a conflict after an uncertain attempt as permission to change or discard its body', async () => {
		const state = harness();
		const change = completion();
		state.enqueue(change);
		const first = state.drain();
		state.requests[0]!.reject(new Error('Response lost after possible commit'));
		await first;
		expect(state.storage.load()[0]?.ambiguous).toBe(true);
		state.retry(change.operationId);
		const retry = state.drain();
		state.requests[1]!.resolve(new Response(JSON.stringify({ code: 'version_conflict', error: 'Changed elsewhere' }), { status: 409 }));
		await retry;
		expect(state.storage.load()).toMatchObject([{ status: 'uncertain', ambiguous: true, body: change.body }]);
		await state.discard(change.operationId);
		expect(() => state.enqueue({ ...change, body: change.body.replace('true', 'false') })).toThrow('still syncing');
		expect(state.storage.load()).toHaveLength(1);
		expect(state.requests[1]?.init).toEqual(state.requests[0]?.init);
	});

	it.each(['pending', 'uncertain'] as const)('retains uncertainty for a previously dispatched %s command after restart', async status => {
		const storage = memoryStorage();
		const change = { ...completion(), status, attempts: 1 };
		storage.put(change);
		const state = harness(storage);
		if (status === 'uncertain') state.retry(change.operationId);
		const draining = state.drain();
		state.requests[0]!.resolve(new Response(JSON.stringify({ code: 'version_conflict', error: 'Changed elsewhere' }), { status: 409 }));
		await draining;
		expect(storage.load()).toMatchObject([{ status: 'uncertain', ambiguous: true, body: change.body }]);
		await state.discard(change.operationId);
		expect(storage.load()).toHaveLength(1);
	});

	it('serializes controllers in different tabs through the same lock until acknowledgement is durable', async () => {
		let tail = Promise.resolve();
		const withLock = (work: () => Promise<void>) => {
			const result = tail.then(work);
			tail = result.catch(() => {});
			return result;
		};
		const storage = memoryStorage();
		const first = harness(storage, withLock);
		const second = harness(storage, withLock);
		const committed = deferred<void>();
		first.commit.mockImplementation(() => committed.promise);
		first.enqueue(completion());
		const firstDrain = first.drain();
		const secondDrain = second.drain();
		await vi.waitFor(() => expect(first.requests).toHaveLength(1));
		expect(second.requests).toEqual([]);
		first.requests[0]!.resolve(confirmed());
		await vi.waitFor(() => expect(first.commit).toHaveBeenCalledOnce());
		expect(second.requests).toEqual([]);
		committed.resolve();
		await Promise.all([firstDrain, secondDrain]);
		expect(storage.load()).toEqual([]);
		expect(second.requests).toEqual([]);
	});

	it('preserves a rejected save draft across controller reload', async () => {
		const state = harness();
		const change = save();
		state.enqueue(change);
		const draining = state.drain();
		state.requests[0]!.resolve(new Response(JSON.stringify({ error: 'Invalid title' }), { status: 400 }));
		await draining;
		const reloaded = harness(state.storage);
		const [pending] = reloaded.refresh();
		expect(pending).toMatchObject({ status: 'failed', modal: change.modal, optimistic: change.optimistic, body: change.body });
		await reloaded.drain();
		expect(reloaded.requests).toEqual([]);
	});

	it('cannot discard or replace an uncertain command with edited input', async () => {
		const state = harness();
		const change = completion();
		state.enqueue(change);
		const draining = state.drain();
		state.requests[0]!.reject(new Error('Connection lost'));
		await draining;
		await state.discard(change.operationId);
		expect(state.storage.load()).toHaveLength(1);
		expect(() => state.enqueue({ ...change, body: change.body.replace('true', 'false') })).toThrow('still syncing');
		expect(() => state.enqueue(completion())).toThrow('pending change');
		expect(state.storage.load()[0]?.body).toBe(change.body);
	});

	it('accepts a corrected draft after definite rejection using the original identity', async () => {
		const state = harness();
		const original = save();
		state.enqueue(original);
		const first = state.drain();
		state.requests[0]!.resolve(new Response(JSON.stringify({ error: 'Invalid title' }), { status: 400 }));
		await first;
		const corrected = { ...original, body: original.body.replace('My draft', 'Corrected title') };
		state.enqueue(corrected);
		const retry = state.drain();
		expect(state.requests[1]?.init?.body).toBe(corrected.body);
		expect(state.storage.load()[0]?.operationId).toBe(original.operationId);
		state.requests[1]!.resolve(confirmed());
		await retry;
		expect(state.storage.load()).toEqual([]);
	});

	it('ignores a success response after logout and does not revive the queue', async () => {
		const state = harness();
		const change = completion();
		state.enqueue(change);
		const draining = state.drain();
		state.invalidate();
		state.storage.remove(change.operationId);
		state.onChange.mockClear();
		state.requests[0]!.resolve(confirmed());
		await draining;
		expect(state.commit).not.toHaveBeenCalled();
		expect(state.onChange).not.toHaveBeenCalled();
		expect(state.onSettled).not.toHaveBeenCalled();
		expect(state.storage.load()).toEqual([]);
	});

	it('throws a durability failure before optimistic state or network work begins', async () => {
		const state = harness();
		vi.spyOn(state.storage, 'put').mockImplementation(() => { throw new Error('Storage is full'); });
		expect(() => state.enqueue(save())).toThrow('Storage is full');
		await state.drain();
		expect(state.onChange).not.toHaveBeenCalled();
		expect(state.apiFetch).not.toHaveBeenCalled();
	});

	it('keeps offline changes durable until the connection returns', async () => {
		vi.stubGlobal('navigator', { onLine: false });
		const state = harness();
		state.enqueue(completion());
		await state.drain();
		expect(state.requests).toEqual([]);
		expect(state.storage.load()).toHaveLength(1);
		vi.stubGlobal('navigator', { onLine: true });
		const draining = state.drain();
		state.requests[0]!.resolve(confirmed());
		await draining;
		expect(state.storage.load()).toEqual([]);
	});

	it.each([
		[500, { error: 'Internal server error' }],
		[409, { code: 'operation_mismatch', error: 'Mismatched command' }],
		[200, { success: true }],
	])('keeps an ambiguous %s response retryable', async (status, body) => {
		const state = harness();
		const change = completion();
		state.enqueue(change);
		const draining = state.drain();
		state.requests[0]!.resolve(new Response(JSON.stringify(body), { status }));
		await draining;
		expect(state.storage.load()).toMatchObject([{ status: 'uncertain', operationId: change.operationId, body: change.body }]);
		expect(state.commit).not.toHaveBeenCalled();
	});
});
