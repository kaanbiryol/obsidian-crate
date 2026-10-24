import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearLocalData } from './local-data-cleanup';
import { clearReadingData } from '../reading/storage/storage';
import { clearReminderDrafts } from '../reminders/editor/reminder-drafts';
import { clearReminderOutbox } from '../reminders/outbox/reminder-outbox-storage';
import { clearCachedReminderSnapshots } from '../reminders/cache/reminder-cache';
import { clearEncryptionSessionMarkers, clearPersistedEncryption } from '../encryption/encryption-cleanup';

const calls = vi.hoisted((): string[] => []);
vi.mock('../encryption/encryption-cleanup', () => ({
	clearEncryptionSessionMarkers: vi.fn(() => { calls.push('markers'); }),
	clearPersistedEncryption: vi.fn(async () => { calls.push('encryption'); }),
}));
vi.mock('../reminders/editor/reminder-drafts', () => ({ clearReminderDrafts: vi.fn(() => { calls.push('drafts'); return true; }) }));
vi.mock('../reminders/outbox/reminder-outbox-storage', () => ({ clearReminderOutbox: vi.fn(() => { calls.push('outbox'); }) }));
vi.mock('../reading/storage/storage', () => ({ clearReadingData: vi.fn(async () => { calls.push('reading'); }) }));
vi.mock('../reminders/cache/reminder-cache', () => ({ clearCachedReminderSnapshots: vi.fn(async () => { calls.push('snapshots'); return true; }) }));
afterEach(() => { calls.length = 0; vi.clearAllMocks(); });

const ALL_STEPS = ['markers', 'drafts', 'outbox', 'reading', 'snapshots', 'encryption'];
const failures: Array<[string, () => void, string]> = [
	['session markers', () => vi.mocked(clearEncryptionSessionMarkers).mockImplementationOnce(() => { calls.push('markers'); throw new Error('denied'); }),
		'The previous encryption session could not be cleared. Clear this site’s data before enrolling again.'],
	['drafts', () => vi.mocked(clearReminderDrafts).mockImplementationOnce(() => { calls.push('drafts'); return false; }),
		'Drafts could not be cleared. Clear this site’s data in browser settings.'],
	['pending changes', () => vi.mocked(clearReminderOutbox).mockImplementationOnce(() => { calls.push('outbox'); throw new Error('denied'); }),
		'Could not clear pending changes from this device. Clear this site’s data in browser settings.'],
	['Reading data', () => vi.mocked(clearReadingData).mockImplementationOnce(async () => { calls.push('reading'); throw new Error('blocked'); }),
		'Reading data could not be cleared. Clear this site’s data in browser settings.'],
	['an unconfirmed offline copy', () => vi.mocked(clearCachedReminderSnapshots).mockImplementationOnce(async () => { calls.push('snapshots'); return false; }),
		'Offline data could not be cleared. Close other Crate tabs, then clear this site’s data in browser settings.'],
	['a failed offline copy', () => vi.mocked(clearCachedReminderSnapshots).mockImplementationOnce(async () => { calls.push('snapshots'); throw new Error('blocked'); }),
		'Offline data could not be cleared. Close other Crate tabs, then clear this site’s data in browser settings.'],
	['encryption keys', () => vi.mocked(clearPersistedEncryption).mockImplementationOnce(async () => { calls.push('encryption'); throw new Error('blocked'); }),
		'Encrypted data or keys could not be removed. Clear this site’s data in browser settings.'],
];

describe('clearLocalData', () => {
	it('clears every store in order with the captured authority', async () => {
		const isCurrent = () => true, report = vi.fn();
		await clearLocalData(isCurrent, report, true);
		expect(calls).toEqual(ALL_STEPS);
		expect(report).not.toHaveBeenCalled();
		for (const step of [clearEncryptionSessionMarkers, clearReadingData, clearCachedReminderSnapshots, clearPersistedEncryption]) {
			expect(step).toHaveBeenCalledWith(isCurrent);
		}
	});

	it.each(failures)('reports %s and still runs the remaining steps', async (_name, fail, message) => {
		fail();
		const report = vi.fn();
		await clearLocalData(() => true, report, true);
		expect(calls).toEqual(ALL_STEPS);
		expect(report.mock.calls).toEqual([[message]]);
	});

	it('keeps private data when the session only expires', async () => {
		const report = vi.fn();
		await clearLocalData(() => true, report, false);
		expect(calls).toEqual(['snapshots']);
		expect(report).not.toHaveBeenCalled();
	});
});
