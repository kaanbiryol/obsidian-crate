import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ErrorState } from './AuthStates';

function render(error: string): string {
	return renderToStaticMarkup(React.createElement(ErrorState, {
		error, config: { folderPath: 'Reminders', upcomingDays: 7, allDayNotificationTime: null }, onRetry: vi.fn(),
	}));
}

describe('signed-out recovery instructions', () => {
	it.each([
		'The saved sign-in could not be removed. Clear this site’s data in browser settings and revoke this browser session in Obsidian.',
		'Drafts could not be cleared. Clear this site’s data in browser settings.',
		'Could not clear pending changes from this device. Clear this site’s data in browser settings.',
		'Offline data could not be cleared. Close other Crate tabs, then clear this site’s data in browser settings.',
		'Logged out locally. Remote cleanup could not finish. Remove this browser session from Crate’s connected devices in Obsidian.',
	])('shows incomplete cleanup and the required recovery: %s', error => {
		const markup = render(error);
		expect(markup).toContain('Cleanup needs attention');
		expect(markup).toContain(error);
		expect(markup).toContain('role="alert"');
		expect(markup).toContain('Open Obsidian');
		expect(markup).not.toContain('Try again');
	});

	it('preserves pending-work recovery guidance after session expiry', () => {
		const error = 'Session expired. Pending changes and drafts are kept on this device. Reconnect to their original reminders folder to recover them.';
		const markup = render(error);
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
