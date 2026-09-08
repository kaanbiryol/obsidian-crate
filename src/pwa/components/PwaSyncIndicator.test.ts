import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { PendingReminderChange } from '../reminder-outbox-types';
import { PwaSyncIndicator } from './PwaSyncIndicator';

const pending: PendingReminderChange = {
	operationId: 'operation', kind: 'save', status: 'pending', path: '/reminders/create',
	method: 'POST', body: '{}', attempts: 1, retryAt: 0,
};

function render(overrides: Partial<React.ComponentProps<typeof PwaSyncIndicator>> = {}) {
	return renderToStaticMarkup(React.createElement(PwaSyncIndicator, {
		changes: [], isOffline: false, refreshing: false, dataMode: 'live', error: null, storageError: null,
		...overrides,
	}));
}

describe('PWA header sync indicator', () => {
	it('announces pending changes without adding an interactive control', () => {
		const markup = render({ changes: [pending] });
		expect(markup).toContain('data-sync-state="syncing"');
		expect(markup).toContain('Syncing 1 change');
		expect(markup).toContain('role="status"');
		expect(markup).toContain('aria-live="polite"');
		expect(markup).not.toContain('<button');
	});

	it('uses the same indicator for background refresh and successful completion', () => {
		expect(render({ refreshing: true })).toContain('Refreshing reminders');
		expect(render()).toContain('data-sync-state="synced"');
		expect(render()).toContain('All changes synced');
	});

	it('does not report cached or disconnected data as synced', () => {
		expect(render({ dataMode: 'cached' })).toContain('data-sync-state="cached"');
		expect(render({ isOffline: true })).toContain('data-sync-state="offline"');
		expect(render({ isOffline: true, changes: [pending] })).toContain('Offline: 1 change waiting to sync');
	});

	it('keeps failed and uncertain changes visible even while another change syncs', () => {
		const markup = render({ changes: [pending, { ...pending, operationId: 'failure', status: 'failed' }, { ...pending, operationId: 'uncertain', status: 'uncertain' }] });
		expect(markup).toContain('data-sync-state="error"');
		expect(markup).toContain('2 changes need attention');
	});

	it.each([
		{ storageError: 'Storage unavailable' },
		{ dataMode: 'error' as const },
		{ dataMode: 'cached' as const, error: 'Refresh failed' },
	])('does not claim success when reading or loading pending changes fails', (props) => {
		expect(render(props)).toContain('data-sync-state="error"');
	});
});
