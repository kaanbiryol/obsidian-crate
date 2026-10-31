/**
 * Frozen reminder outbox entries (`crate-reminder-outbox:v1:` localStorage keys)
 * as the released PWA saved them. After an update the PWA must still load each
 * unsent command and send its exact saved request body and operation ID.
 *
 * Fixtures in `__fixtures__/` are append-only. To freeze a new version, append an
 * entry below with a new file name (for example `outbox-save.v2.json`), then run
 * `CRATE_WRITE_FIXTURES=outbox-save.v2.json npx vitest run src/pwa/reminders/outbox/reminder-outbox.fixtures.test.ts`.
 * Only the missing file is written; review and commit it. Never edit or
 * regenerate an existing fixture. See `src/test/frozen-fixtures.ts`.
 */
import { afterEach, describe, vi } from 'vitest';
import { testFrozenFixtures } from '@/test/frozen-fixtures';
import { createReminderOutboxStorage } from './reminder-outbox-storage';
import { buildReminderMutationBody } from './reminder-mutation';
import { predictSavedReminder } from './reminder-optimistic-state';
import type { PendingReminderChange } from './reminder-outbox-types';

interface SavedOutbox { authToken: string; folderPath: string; entries: Record<string, string> }

const authToken = 'synthetic-web-session-credential';
const folderPath = 'Reminders';
const operationId = 'e1_00020757_0a14f966-767d-4908-8cc9-b1f0f10d1cc2';

function memoryStorage(values: Map<string, string>): Storage {
	return {
		get length() { return values.size; },
		key: (index: number) => [...values.keys()][index] ?? null,
		getItem: (key: string) => values.get(key) ?? null,
		setItem: (key: string, value: string) => { values.set(key, value); },
		removeItem: (key: string) => { values.delete(key); },
		clear: () => values.clear(),
	};
}

async function save(change: PendingReminderChange): Promise<SavedOutbox> {
	const values = new Map<string, string>();
	vi.stubGlobal('localStorage', memoryStorage(values));
	vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-31T16:57:20.000Z'));
	(await createReminderOutboxStorage(authToken, folderPath)).put(change);
	return { authToken, folderPath, entries: Object.fromEntries(values) };
}

async function load(saved: SavedOutbox) {
	vi.stubGlobal('localStorage', memoryStorage(new Map(Object.entries(saved.entries))));
	const outbox = await createReminderOutboxStorage(saved.authToken, saved.folderPath);
	return { changes: outbox.load(), quarantined: outbox.quarantined() };
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('frozen reminder outbox entries', () => {
	testFrozenFixtures(new URL('./__fixtures__/', import.meta.url), [
		{
			// An offline create, with the request body the editor built.
			file: 'outbox-save.v1.json',
			stored: () => {
				const input = buildReminderMutationBody({ config: { folderPath }, mode: 'create', projects: ['Inbox'], selectedProject: null, draft: {
					content: 'Water the plants', description: 'Synthetic note', project: 'Inbox', defaultProject: 'Inbox',
					dueDate: '2099-01-02', dueTime: '09:30', priority: 4, activePicker: null, deleteConfirm: false,
				} });
				return save({ operationId, recordId: operationId, kind: 'save', path: '/reminders/create', method: 'POST',
					body: JSON.stringify({ ...input, id: operationId, operationId }), status: 'pending', attempts: 0, retryAt: 0,
					optimistic: predictSavedReminder(operationId, input) });
			},
			decode: load,
		},
		{
			// A completion whose response was lost, so it must be retried unchanged.
			file: 'outbox-complete-uncertain.v1.json',
			stored: () => save({ operationId: 'e1_00020757_1b25fa77-878e-4a19-9dd0-c2f1f21e2dd3', recordId: 'r-existing', kind: 'complete',
				path: '/reminders/set-completed', method: 'POST', status: 'uncertain', attempts: 2, retryAt: 1_793_000_000_000, ambiguous: true,
				body: JSON.stringify({ operationId: 'e1_00020757_1b25fa77-878e-4a19-9dd0-c2f1f21e2dd3', folderPath, id: 'r-existing', completed: true,
					filePath: 'Reminders/Inbox.md', expectedRevision: 'e0dbd2afdcc4108bf3710031c9235a78f742f564fcaec72bdbc842c8b80657f2' }) }),
			decode: load,
		},
	]);
});
