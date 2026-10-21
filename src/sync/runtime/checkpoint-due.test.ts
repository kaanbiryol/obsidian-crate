import { describe, expect, it } from 'vitest';
import type { SyncHistoryEntry } from '../types';
import { checkpointDue } from './sync-activity';

const entry = (timestamp: string, fields: Partial<SyncHistoryEntry> = {}) => ({ timestamp, type: 'sync', success: true, ...fields }) as SyncHistoryEntry;
const now = Date.parse('2026-05-01T12:00:00Z');
const latest = entry('2026-05-01T12:00:00Z');

describe('checkpointDue', () => {
	it('always checkpoints initial and full syncs', () => {
		const recent = entry('2026-05-01T11:59:00Z', { historyCheckpoint: 'a'.repeat(64) });
		for (const type of ['initial', 'force'] as const) {
			expect(checkpointDue({ type, history: [latest, recent], latest, lastCheckpointAt: now, trackedFiles: 1_000, now })).toBe(true);
		}
	});

	it('checkpoints the first ordinary sync', () => {
		expect(checkpointDue({ type: 'sync', history: [latest], latest, lastCheckpointAt: 0, trackedFiles: 1_000, now })).toBe(true);
	});

	it('spaces ordinary checkpoints by tracked file count', () => {
		// 1,000 files need 360 seconds between checkpoints.
		const previous = entry('2026-05-01T11:55:00Z', { sharedCheckpoint: 'shared' });
		const history = [latest, previous];
		expect(checkpointDue({ type: 'sync', history, latest, lastCheckpointAt: 0, trackedFiles: 1_000, now })).toBe(false);
		expect(checkpointDue({ type: 'sync', history, latest, lastCheckpointAt: 0, trackedFiles: 1_000, now: now + 60_000 })).toBe(true);
	});

	it('remembers a checkpoint that fell out of history', () => {
		expect(checkpointDue({ type: 'sync', history: [latest], latest, lastCheckpointAt: now - 60_000, trackedFiles: 1_000, now })).toBe(false);
	});
});
