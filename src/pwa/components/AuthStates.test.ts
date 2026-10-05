import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ErrorState } from './AuthStates';
import type { ConnectionIssueKind } from '../connection/issues';

function render(message: string, kind: ConnectionIssueKind = 'unavailable'): string {
	return renderToStaticMarkup(React.createElement(ErrorState, {
		issue: { kind, message }, onRetry: vi.fn(),
	}));
}

describe('signed-out recovery instructions', () => {
	it.each([
		['cleanup', 'Cleanup needs attention'],
		['reconnect', 'Reconnect to Crate'],
		['unavailable', 'Unable to connect'],
	] as const)('chooses %s recovery independently of error wording', (kind, title) => {
		const markup = render('Session expired; remote cleanup could not finish.', kind);
		expect(markup).toContain(`<h1 id="auth-title">${title}</h1>`);
		expect(markup.includes('Try again')).toBe(kind !== 'cleanup');
	});

	it.each([
		'The saved sign-in could not be removed. Clear this site’s data in browser settings and revoke this browser session in Obsidian.',
		'Drafts could not be cleared. Clear this site’s data in browser settings.',
		'Could not clear pending changes from this device. Clear this site’s data in browser settings.',
		'Offline data could not be cleared. Close other Crate tabs, then clear this site’s data in browser settings.',
		'Logged out locally. Remote cleanup could not finish. Remove this browser session from Crate’s connected devices in Obsidian.',
	])('shows incomplete cleanup and the required recovery: %s', error => {
		const markup = render(error, 'cleanup');
		expect(markup).toContain('Cleanup needs attention');
		expect(markup).toContain(error);
		expect(markup).toContain('role="alert"');
		expect(markup).toContain('Open Obsidian');
		expect(markup).not.toContain('Try again');
	});

	it('preserves pending-work recovery guidance after session expiry', () => {
		const error = 'Session expired. Pending changes and drafts are kept on this device. Reconnect to their original reminders folder to recover them.';
		const markup = render(error, 'reconnect');
		expect(markup).toContain('Reconnect to Crate');
		expect(markup).toContain(error);
		expect(markup).toContain('Try again');
	});

	it('renders connection failure details as text with a retry action', () => {
		const markup = render('Network unavailable <script>alert(1)</script>');
		expect(markup).toContain('Unable to connect');
		expect(markup).toContain('Network unavailable &lt;script&gt;');
		expect(markup).not.toContain('<script>');
		expect(markup).toContain('Try again');
	});
});
