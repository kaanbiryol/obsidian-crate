import type { PendingReminderChange } from './reminder-outbox-types';

const PREFIX = 'crate-reminder-outbox:';
const OPERATION_ID = /^[a-zA-Z0-9_-]{16,128}$/;
const STORAGE_ERROR = 'Could not access pending changes on this device. Free up storage and try again.';
const CORRUPT_ERROR = 'Pending changes on this device could not be read. Keep this app open and try again.';

export interface ReminderOutboxStorage {
	load(): PendingReminderChange[];
	put(change: PendingReminderChange): void;
	remove(operationId: string): void;
	acceptsKey(key: string | null): boolean;
}

interface StoredChange {
	version: 1;
	createdAt: number;
	change: PendingReminderChange;
}

function object(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function strings(value: unknown): value is string[] {
	return Array.isArray(value) && value.every(item => typeof item === 'string');
}

function validRecord(value: unknown, id: string, folderPath: string): boolean {
	return object(value) && value.id === id && typeof value.content === 'string'
		&& typeof value.project === 'string' && typeof value.filePath === 'string'
		&& value.filePath.startsWith(`${folderPath}/`) && value.filePath.toLowerCase().endsWith('.md')
		&& (value.priority === 1 || value.priority === 4) && typeof value.completed === 'boolean';
}

function validChange(value: unknown, operationId: string, folderPath: string): value is PendingReminderChange {
	if (!object(value) || value.operationId !== operationId || !OPERATION_ID.test(operationId)
		|| !['pending', 'uncertain', 'failed'].includes(String(value.status))
		|| !Number.isSafeInteger(value.attempts) || Number(value.attempts) < 0
		|| typeof value.retryAt !== 'number' || !Number.isFinite(value.retryAt) || value.retryAt < 0
		|| (value.ambiguous !== undefined && typeof value.ambiguous !== 'boolean')
		|| typeof value.body !== 'string' || (value.error !== undefined && typeof value.error !== 'string')) return false;
	let body: unknown;
	try { body = JSON.parse(value.body); } catch { return false; }
	if (!object(body) || body.operationId !== operationId || body.folderPath !== folderPath) return false;
	if (value.followUp !== undefined && (!object(value.followUp) || value.kind !== 'save'
		|| typeof value.followUp.operationId !== 'string' || !OPERATION_ID.test(value.followUp.operationId)
		|| value.followUp.operationId === operationId || !object(value.followUp.input)
		|| value.followUp.input.folderPath !== folderPath || typeof value.followUp.input.content !== 'string'
		|| typeof value.followUp.input.project !== 'string')) return false;
	if (value.kind === 'reorder') {
		return value.path === '/reminders/reorder' && value.method === 'POST'
			&& typeof value.project === 'string' && body.project === value.project
			&& strings(value.orderedIds) && strings(body.expectedOrder)
			&& JSON.stringify(body.orderedIds) === JSON.stringify(value.orderedIds);
	}
	if (typeof value.recordId !== 'string' || !value.recordId || body.id !== value.recordId) return false;
	if (value.optimistic !== undefined && !validRecord(value.optimistic, value.recordId, folderPath)) return false;
	if (value.previous !== undefined && !validRecord(value.previous, value.recordId, folderPath)) return false;
	if (value.modal !== undefined && (!object(value.modal) || !object(value.modal.draft)
		|| !['create', 'edit'].includes(String(value.modal.mode)) || typeof value.modal.draft.content !== 'string')) return false;
	if (value.kind === 'save') return value.method === 'POST'
		&& ['/reminders/create', '/reminders/update'].includes(String(value.path))
		&& typeof body.content === 'string' && typeof body.project === 'string';
	if (value.kind === 'complete') return value.path === '/reminders/set-completed'
		&& value.method === 'POST' && typeof body.completed === 'boolean';
	return value.kind === 'delete' && value.path === '/reminders/delete' && value.method === 'DELETE';
}

function readStored(raw: string, operationId: string, folderPath: string): StoredChange {
	let stored: unknown;
	try { stored = JSON.parse(raw); } catch { throw new Error(CORRUPT_ERROR); }
	if (!object(stored) || stored.version !== 1 || typeof stored.createdAt !== 'number'
		|| !Number.isFinite(stored.createdAt) || stored.createdAt < 0
		|| !validChange(stored.change, operationId, folderPath)) throw new Error(CORRUPT_ERROR);
	return stored as unknown as StoredChange;
}

function browserStorage(): Storage {
	try {
		if (typeof localStorage !== 'undefined') return localStorage;
	} catch { /* Access may be disabled by browser policy. */ }
	throw new Error(STORAGE_ERROR);
}

function storageKeys(storage: Storage): string[] {
	try {
		return Array.from({ length: storage.length }, (_, index) => storage.key(index))
			.filter((key): key is string => key !== null);
	} catch { throw new Error(STORAGE_ERROR); }
}

/** One key per command prevents another tab from replacing an unrelated command. */
export async function createReminderOutboxStorage(authToken: string, folderPath: string): Promise<ReminderOutboxStorage> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(authToken));
	const tokenHash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
	const scope = `${PREFIX}v1:${tokenHash}:${encodeURIComponent(folderPath)}:`;
	const storage = browserStorage();
	const read = (key: string) => {
		let raw: string | null;
		try { raw = storage.getItem(key); } catch { throw new Error(STORAGE_ERROR); }
		return raw === null ? null : readStored(raw, key.slice(scope.length), folderPath);
	};
	return {
		load() {
			return storageKeys(storage).filter(key => key.startsWith(scope))
				.map(key => read(key)).filter((entry): entry is StoredChange => entry !== null)
				.sort((a, b) => a.createdAt - b.createdAt)
				.map(entry => entry.change);
		},
		put(change) {
			if (!validChange(change, change.operationId, folderPath)) throw new Error(CORRUPT_ERROR);
			const key = scope + change.operationId;
			const existing = read(key);
			const canCorrect = existing?.change.status === 'failed' && !existing.change.ambiguous;
			if (existing && ((!canCorrect && (existing.change.body !== change.body || existing.change.path !== change.path
				|| existing.change.method !== change.method)) || (existing.change.ambiguous && !change.ambiguous))) {
				throw new Error('A pending change cannot be replaced before its earlier save is confirmed.');
			}
			const stored: StoredChange = { version: 1, createdAt: existing?.createdAt ?? Date.now(), change };
			try { storage.setItem(key, JSON.stringify(stored)); } catch { throw new Error(STORAGE_ERROR); }
		},
		remove(operationId) {
			if (!OPERATION_ID.test(operationId)) throw new Error(CORRUPT_ERROR);
			try { storage.removeItem(scope + operationId); } catch { throw new Error(STORAGE_ERROR); }
		},
		acceptsKey(key) { return key === null || key.startsWith(scope); },
	};
}

/** Explicit logout/session replacement clears data belonging to every old session. */
export function clearReminderOutbox(): void {
	const storage = browserStorage();
	for (const key of storageKeys(storage).filter(key => key.startsWith(PREFIX))) {
		try { storage.removeItem(key); } catch { throw new Error(STORAGE_ERROR); }
	}
}
