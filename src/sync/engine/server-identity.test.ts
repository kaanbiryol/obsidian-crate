import { describe, expect, it, vi } from 'vitest';
import type { CheckResponse } from '../../protocol/sync-types';
import { normalizePersistedSyncSettings } from '../settings';
import { reconcileServerIdentity } from './server-identity';

const OLD = 'a'.repeat(32);
const NEW = 'b'.repeat(32);

function setup(saved: string | undefined, reported: string | undefined, options: { saveFails?: boolean } = {}) {
	const events: string[] = [];
	const baselines = new Set(['a.md', 'b.md']);
	const settings: { lastSeq: number; serverStorageId?: string } = { lastSeq: 7, ...(saved === undefined ? {} : { serverStorageId: saved }) };
	const context = {
		settings,
		checkForChanges: vi.fn(async (since: number): Promise<CheckResponse> => ({ lastSeq: 9, hasChanges: since < 9, ...(reported === undefined ? {} : { storageId: reported }) })),
		localManifest: {
			getAllPaths: () => [...baselines],
			removeEntry: (path: string) => { baselines.delete(path); },
			save: vi.fn(async () => {
				if (options.saveFails) throw new Error('disk full');
				events.push(`save manifest (${baselines.size} baselines)`);
			}),
		},
		setLastSeq: (value: number) => { settings.lastSeq = value; },
		persistSettings: vi.fn(async () => { events.push(`persist settings (cursor ${settings.lastSeq}, ${settings.serverStorageId})`); }),
	};
	return { context, settings, baselines, events };
}

describe('server storage identity', () => {
	it('adopts the identity of the server a checkpoint without one syncs with', async () => {
		const { context, settings, baselines } = setup(undefined, NEW);
		await reconcileServerIdentity(context);
		expect(settings).toEqual({ lastSeq: 7, serverStorageId: NEW });
		expect(baselines.size).toBe(2);
		expect(context.checkForChanges).toHaveBeenCalledWith(7);
	});

	it('changes nothing for the same server or one that predates identities', async () => {
		for (const [saved, reported] of [[OLD, OLD], [OLD, undefined], [undefined, undefined]] as const) {
			const { context, settings, baselines } = setup(saved, reported);
			await reconcileServerIdentity(context);
			expect(settings.lastSeq).toBe(7);
			expect(settings.serverStorageId).toBe(saved);
			expect(baselines.size).toBe(2);
			expect(context.persistSettings).not.toHaveBeenCalled();
		}
	});

	it('forgets baselines and the cursor before recording another server', async () => {
		const { context, settings, baselines, events } = setup(OLD, NEW);
		await reconcileServerIdentity(context);
		expect(baselines.size).toBe(0);
		expect(settings).toEqual({ lastSeq: 0, serverStorageId: NEW });
		expect(events).toEqual(['save manifest (0 baselines)', `persist settings (cursor 0, ${NEW})`]);
	});

	it('keeps the old identity when the cleared baselines could not be saved, so the next sync clears them again', async () => {
		const { context, settings } = setup(OLD, NEW, { saveFails: true });
		await expect(reconcileServerIdentity(context)).rejects.toThrow('disk full');
		expect(settings.serverStorageId).toBe(OLD);
		expect(context.persistSettings).not.toHaveBeenCalled();
	});

	it('loads only a well-formed saved identity', () => {
		expect(normalizePersistedSyncSettings({ serverStorageId: NEW }, '.obsidian').serverStorageId).toBe(NEW);
		for (const value of ['', 'B'.repeat(32), 'b'.repeat(31), 42, null]) {
			expect(normalizePersistedSyncSettings({ serverStorageId: value as never }, '.obsidian')).not.toHaveProperty('serverStorageId');
		}
	});
});
