import type { PendingReminderChange } from './reminder-outbox-types';
import { isStoredReminderDraft, isStoredReminderRecord } from './reminder-storage-validation';

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

export interface QuarantinedReminderEntry {
	key: string;
	raw: string;
}

interface ReminderOutboxQuarantine {
	quarantined(): QuarantinedReminderEntry[];
	removeQuarantined(entries: QuarantinedReminderEntry[]): void;
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
	return isStoredReminderRecord(value, folderPath) && value.id === id;
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
	if (value.modal !== undefined && (!object(value.modal) || !isStoredReminderDraft(value.modal.draft)
		|| !['create', 'edit'].includes(String(value.modal.mode)))) return false;
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

function recoverableEntries(storage: Storage, keys: string[], folderPath: string) {
	const valid: { key: string; stored: StoredChange }[] = [];
	const quarantined: QuarantinedReminderEntry[] = [];
	for (const key of keys) {
		let raw: string | null;
		try { raw = storage.getItem(key); } catch { throw new Error(STORAGE_ERROR); }
		if (raw === null) continue;
		try { valid.push({ key, stored: readStored(raw, key.slice(key.lastIndexOf(':') + 1), folderPath) }); }
		catch { quarantined.push({ key, raw }); }
	}
	return { valid, quarantined };
}

/** Quarantine in place: no copy, deletion, rewrite or extra quota is needed to preserve bytes. */
function quarantineStorage(storage: Storage, keys: () => string[], folderPath: string): ReminderOutboxQuarantine {
	return {
		quarantined: () => recoverableEntries(storage, keys(), folderPath).quarantined,
		removeQuarantined(entries) {
			const current = new Map(recoverableEntries(storage, keys(), folderPath).quarantined.map(entry => [entry.key, entry.raw]));
			for (const entry of entries) {
				// The user reviewed these exact bytes. A repaired or changed entry
				// from another tab must survive this stale removal request.
				if (current.get(entry.key) !== entry.raw) continue;
				try {
					if (storage.getItem(entry.key) === entry.raw) storage.removeItem(entry.key);
				} catch { throw new Error(STORAGE_ERROR); }
			}
		},
	};
}

async function outboxScope(authToken: string, folderPath: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(authToken));
	const tokenHash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
	return `${PREFIX}v1:${tokenHash}:${encodeURIComponent(folderPath)}:`;
}

/** One key per command prevents another tab from replacing an unrelated command. */
export async function createReminderOutboxStorage(authToken: string, folderPath: string): Promise<ReminderOutboxStorage & ReminderOutboxQuarantine> {
	const scope = await outboxScope(authToken, folderPath);
	const storage = browserStorage();
	const keys = () => storageKeys(storage).filter(key => key.startsWith(scope));
	const read = (key: string) => {
		let raw: string | null;
		try { raw = storage.getItem(key); } catch { throw new Error(STORAGE_ERROR); }
		return raw === null ? null : readStored(raw, key.slice(scope.length), folderPath);
	};
	return {
		...quarantineStorage(storage, keys, folderPath),
		load() {
			return recoverableEntries(storage, keys(), folderPath).valid.map(entry => entry.stored)
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

/** Recovery stays within this browser origin and the exact enrolled folder. */
export async function createReminderRecoveryStorage(authToken: string, folderPath: string) {
	const scope = await outboxScope(authToken, folderPath);
	const storage = browserStorage();
	const acceptsKey = (key: string | null) => {
		if (key === null) return true;
		const parts = key.split(':');
		return parts.length === 5 && `${parts[0]}:` === PREFIX && parts[1] === 'v1'
			&& /^[a-f0-9]{64}$/.test(parts[2] ?? '') && parts[3] === encodeURIComponent(folderPath);
	};
	const keys = () => storageKeys(storage).filter(key => acceptsKey(key) && !key.startsWith(scope));
	const entries = () => recoverableEntries(storage, keys(), folderPath).valid;
	return {
		...quarantineStorage(storage, keys, folderPath),
		acceptsKey,
		load() {
			return entries().sort((a, b) => a.stored.createdAt - b.stored.createdAt).map(entry => entry.stored.change);
		},
		// Call under the same Web Lock as sending. Each destination is durable
		// before its source disappears; a crash can leave safe duplicate receipts.
		adopt() {
			for (const { key, stored } of entries()) {
				const destination = scope + stored.change.operationId;
				const existing = storage.getItem(destination);
				if (existing !== null) {
					let current: PendingReminderChange;
					try { current = readStored(existing, stored.change.operationId, folderPath).change; }
					catch { continue; } // Keep both the damaged destination and healthy recovery source.
					if (current.body !== stored.change.body || current.path !== stored.change.path || current.method !== stored.change.method) {
						throw new Error('These saved changes have conflicting operation IDs. Export them before recovering.');
					}
				} else {
					try { storage.setItem(destination, JSON.stringify(stored)); } catch { throw new Error(STORAGE_ERROR); }
				}
				try { storage.removeItem(key); } catch { throw new Error(STORAGE_ERROR); }
			}
		},
	};
}

/** Only explicit logout clears data belonging to every old session. */
export function clearReminderOutbox(): void {
	const storage = browserStorage();
	for (const key of storageKeys(storage).filter(key => key.startsWith(PREFIX))) {
		try { storage.removeItem(key); } catch { throw new Error(STORAGE_ERROR); }
	}
}
