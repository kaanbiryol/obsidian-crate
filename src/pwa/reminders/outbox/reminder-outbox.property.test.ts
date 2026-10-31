import fc from 'fast-check';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createReminderOutbox } from './reminder-outbox';
import type { ReminderOutboxStorage } from './reminder-outbox-storage';
import type { PendingReminderChange } from './reminder-outbox-types';
import type { ReminderRecord } from '../types';

type Outcome = 'ok' | 'network' | 'server' | 'rejected' | 'lost';

function completion(id: string): PendingReminderChange {
	const previous: ReminderRecord = { id, content: `Task ${id}`, revision: `revision-${id}`, project: 'Inbox',
		filePath: 'Reminders/Inbox.md', priority: 4, completed: false };
	const operationId = `op-${id}`;
	return { operationId, kind: 'complete', recordId: id, previous, optimistic: { ...previous, completed: true },
		status: 'pending', attempts: 0, retryAt: 0, path: '/reminders/set-completed', method: 'POST',
		body: JSON.stringify({ operationId, id, folderPath: 'Reminders', filePath: previous.filePath,
			expectedRevision: previous.revision, completed: true }) };
}

function memoryStorage(): ReminderOutboxStorage {
	const entries = new Map<string, PendingReminderChange>();
	return {
		load: () => structuredClone([...entries.values()]),
		get: id => structuredClone(entries.get(id) ?? null),
		put: change => { entries.set(change.operationId, structuredClone(change)); },
		remove: id => { entries.delete(id); },
		acceptsKey: () => true,
	};
}

beforeEach(() => vi.stubGlobal('navigator', { onLine: true }));
afterEach(() => vi.unstubAllGlobals());

// 'lost' models a server that committed the change but whose response never arrived.
const outcome = fc.constantFrom<Outcome>('ok', 'network', 'server', 'rejected', 'lost');

it('retries resend the exact same command and settle each operation at most once', async () => {
	await fc.assert(fc.asyncProperty(
		fc.uniqueArray(fc.constantFrom('a', 'b', 'c', 'd'), { minLength: 1 }),
		fc.array(outcome, { maxLength: 24 }),
		fc.array(fc.constantFrom('resume' as const, 'drain' as const, 'both' as const), { minLength: 1, maxLength: 8 }),
		async (ids, generatedOutcomes, rounds) => {
			// Copy so a failure report shows the generated outcomes, not what is left of them.
			const outcomes = [...generatedOutcomes];
			const storage = memoryStorage();
			const original = new Map(ids.map(id => [`op-${id}`, completion(id)]));
			for (const change of original.values()) storage.put(change);
			const sent: Array<{ path: string; init?: RequestInit }> = [];
			const serverCommitted = new Set<string>();
			const apiFetch = vi.fn(async (path: string, init?: RequestInit) => {
				sent.push({ path, init });
				const { operationId, id } = JSON.parse(init!.body as string) as { operationId: string; id: string };
				const next = outcomes.shift() ?? 'ok';
				if (next === 'network') throw new TypeError('Failed to fetch');
				if (next === 'server') return new Response(JSON.stringify({ error: 'Unavailable' }), { status: 503 });
				// Even a replay of a committed operation can meet a conflict, as when its own commit moved the revision.
				if (next === 'rejected') return new Response(JSON.stringify({ error: 'Conflict' }), { status: 409 });
				serverCommitted.add(operationId);
				if (next === 'lost') throw new TypeError('Failed to fetch');
				return new Response(JSON.stringify({ success: true, reminder: { ...completion(id).optimistic, revision: `done-${id}` } }));
			});
			const commit = vi.fn(async (_change: PendingReminderChange) => {});
			const outbox = createReminderOutbox({ storage, apiFetch, isCurrent: () => true, beginMutation: () => () => {},
				commit, onChange: () => {}, onError: () => {}, onSettled: () => {} });

			for (const round of rounds) {
				if (round === 'resume') await outbox.resume();
				else if (round === 'drain') await outbox.drain();
				else await Promise.all([outbox.resume(), outbox.drain()]);
			}
			// Then the network recovers: every outcome left is a success.
			outcomes.length = 0;
			for (let attempt = 0; attempt < 3; attempt++) await outbox.resume();

			for (const request of sent) {
				const { operationId } = JSON.parse(request.init!.body as string) as { operationId: string };
				const queued = original.get(operationId)!;
				expect(request.path).toBe(queued.path);
				expect(request.init?.method).toBe(queued.method);
				expect(request.init?.body).toBe(queued.body);
			}
			const committed = commit.mock.calls.map(([change]) => change.operationId);
			expect(new Set(committed).size).toBe(committed.length);
			const remaining = storage.load();
			for (const operationId of original.keys()) {
				const left = remaining.find(item => item.operationId === operationId);
				// Settled exactly once, or rejected before any attempt could commit and left for the user.
				if (committed.includes(operationId)) expect(left).toBeUndefined();
				else {
					expect(left?.status).toBe('failed');
					expect(left?.ambiguous).toBeFalsy();
					expect(serverCommitted.has(operationId)).toBe(false);
				}
			}
		}), { numRuns: 100 });
});
