import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { PendingReminderChange } from '../reminder-outbox-types';
import { ReminderSyncNotice } from './ReminderSyncNotice';

function change(patch: Partial<PendingReminderChange> = {}): PendingReminderChange {
	return {
		operationId: 'operation', kind: 'save', status: 'failed', path: '/reminders/create',
		method: 'POST', body: '{}', attempts: 1, retryAt: 0,
		optimistic: { id: 'reminder', content: 'Buy milk', description: 'Two cartons', priority: 4, completed: false, project: 'Inbox', filePath: 'Reminders/Inbox.md' },
		...patch,
	};
}

function render(changes: PendingReminderChange[], isOffline = false): string {
	return renderToStaticMarkup(React.createElement(ReminderSyncNotice, {
		changes, isOffline, onRetry: vi.fn(), onEdit: vi.fn(), onDiscard: vi.fn(),
	}));
}

describe('PWA reminder sync recovery notice', () => {
	it('preserves a rejected save’s title and description with recovery actions', () => {
		const markup = render([change()]);
		expect(markup).toContain('Not saved: Buy milk');
		expect(markup).toContain('Two cartons');
		for (const action of ['Retry', 'Edit', 'Discard']) expect(markup).toContain(`aria-label="${action}: Buy milk"`);
	});

	it('does not offer destructive recovery before an ambiguous result is confirmed', () => {
		const markup = render([change({ status: 'uncertain' })]);
		expect(markup).toContain('Couldn’t sync: Buy milk');
		expect(markup).toContain('aria-label="Retry: Buy milk"');
		expect(markup).not.toContain('>Discard</button>');
		expect(markup).not.toContain('>Dismiss</button>');
		expect(markup).not.toContain('>Edit</button>');
	});

	it('offers retry and dismissal for a reverted deletion', () => {
		const markup = render([change({ kind: 'delete' })]);
		expect(markup).toContain('Couldn’t delete reminder: Buy milk');
		expect(markup).toContain('aria-label="Dismiss: Buy milk"');
		expect(markup).not.toContain('>Discard</button>');
	});

	it('keeps offline pending progress distinct from saved failures', () => {
		const markup = render([change({ status: 'pending' }), change({ operationId: 'failure' })], true);
		expect(markup).toContain('Waiting for connection · 1 change');
		expect(markup).toMatch(/<button[^>]*disabled=""[^>]*aria-label="Retry: Buy milk"/);
		expect(render([])).toBe('');
	});

	it('keeps a storage failure actionable even when no changes could be loaded', () => {
		const markup = renderToStaticMarkup(React.createElement(ReminderSyncNotice, {
			changes: [], isOffline: false, onRetry: vi.fn(), onEdit: vi.fn(), onDiscard: vi.fn(),
			storageError: 'Free up storage and try again.', onRetryInitialization: vi.fn(),
		}));
		expect(markup).toContain('aria-label="Pending changes unavailable"');
		expect(markup).toContain('Free up storage and try again.');
		expect(markup).toContain('aria-label="Retry loading pending changes"');
	});
});
