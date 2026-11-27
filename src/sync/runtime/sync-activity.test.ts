import { describe, expect, it } from 'vitest';
import { createTestSettings } from '../../test/factories/settings';
import { createEmptySyncResult } from '../sync-result';
import type { RequestDiagnostic } from '../diagnostics/request-diagnostics';
import { recordSyncHistory } from './sync-activity';
import { MAX_SYNC_HISTORY } from '../settings';

const session = '11111111-1111-4111-8111-111111111111';
const request = (second: number): RequestDiagnostic => ({
	at: `2026-01-01T00:00:${String(second).padStart(2, '0')}.000Z`, operationId: `00000000-0000-4000-8000-0000000000${String(second).padStart(2, '0')}`,
	method: 'GET', route: '/sync/check', status: 200, outcome: 'response',
});

describe('recordSyncHistory', () => {
	it('keeps only the diagnostic rows no earlier entry holds', () => {
		const settings = createTestSettings({ syncHistory: [] });
		recordSyncHistory(settings, 'sync', createEmptySyncResult(), { requestDiagnostics: { clientSession: session, requests: [request(1), request(2)] } });
		// The rolling log still holds the first sync's rows.
		const entry = recordSyncHistory(settings, 'sync', createEmptySyncResult(), { requestDiagnostics: { clientSession: session, requests: [request(1), request(2), request(3)] } });
		expect(entry.requestDiagnostics?.requests).toEqual([request(3)]);
		expect(settings.syncHistory.map(item => item.requestDiagnostics?.requests.length)).toEqual([1, 2]);
	});

	it('keeps rows that only the entry about to be dropped held', () => {
		const settings = createTestSettings({ syncHistory: [] });
		for (let second = 1; second <= MAX_SYNC_HISTORY; second++) {
			recordSyncHistory(settings, 'sync', createEmptySyncResult(), { requestDiagnostics: { clientSession: session, requests: [request(second)] } });
		}
		// The window still holds the oldest entry's row, and that entry is dropped now.
		const entry = recordSyncHistory(settings, 'sync', createEmptySyncResult(), { requestDiagnostics: { clientSession: session,
			requests: [request(1), request(MAX_SYNC_HISTORY + 1)] } });
		expect(entry.requestDiagnostics?.requests).toEqual([request(1), request(MAX_SYNC_HISTORY + 1)]);
		expect(settings.syncHistory).toHaveLength(MAX_SYNC_HISTORY);
	});
});

