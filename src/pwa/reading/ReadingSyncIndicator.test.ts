import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PwaSyncStatusIndicator } from '../components/PwaSyncStatusIndicator';
import { readingSyncStatus } from '../sync/reading-status';
import type { PendingReading } from './outbox';

const change: PendingReading = { id: 'change', sessionId: 'session', action: 'update', intent: { id: 'article', changes: { favorite: true }, before: { favorite: false } } };
function render(props: Partial<Parameters<typeof readingSyncStatus>[0]> = {}) {
	return renderToStaticMarkup(React.createElement(PwaSyncStatusIndicator, {
		...readingSyncStatus({
		pending: [], isOffline: false, loading: false, refreshing: false, confirmed: true,
		error: null, recovery: false, ...props,
		}), onShowStatus: () => undefined,
	}));
}

describe('Reading sync indicator', () => {
	it('only confirms success after an online refresh of the current session', () => {
		expect(render({ confirmed: false })).toContain('data-sync-state="syncing"');
		expect(render({ confirmed: false })).toContain('Checking Reading');
		expect(render({ confirmed: false, isOffline: true })).toContain('data-sync-state="offline"');
		expect(render({ loading: true, confirmed: false })).toContain('Loading Reading');
		expect(render({ refreshing: true })).toContain('Refreshing Reading');
		expect(render()).toContain('aria-label="Sync status: All changes synced"');
	});
	it('keeps queued changes unconfirmed and updates the offline status', () => {
		expect(render({ pending: [change] })).toContain('Syncing 1 change');
		expect(render({ pending: [change], isOffline: true })).toContain('Offline: 1 change waiting to sync');
		expect(render({ isOffline: true })).toContain('data-sync-state="offline"');
	});
	it.each([
		{ error: 'Storage unavailable' },
		{ recovery: true },
		{ pending: [{ ...change, error: 'Save acknowledgement interrupted' }] },
		{ pending: [change, { ...change, id: 'conflict', review: true }], refreshing: true },
	])('never reports failed, uncertain, or review-required work as synced', props => {
		const markup = render(props);
		expect(markup).toContain('data-sync-state="error"');
		expect(markup).not.toContain('All changes synced');
	});
});
