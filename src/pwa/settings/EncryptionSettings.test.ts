import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { parseHTML } from 'linkedom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { reminderEncryptionSnapshot } from '../reminders/encryption-session';
import type { SettingsSnapshot } from './settings-store';
import { EncryptionSettings, EncryptionSetupHint } from './EncryptionSettings';

vi.mock('../reminders/encryption-session', () => ({ reminderEncryptionSnapshot: vi.fn(), subscribeReminderEncryption: vi.fn() }));
vi.mock('react', async importOriginal => ({
	...await importOriginal<typeof import('react')>(),
	useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot(),
}));

function reading(status?: 'unencrypted' | 'ready' | 'locked', ready = true): SettingsSnapshot['reading'] {
	return { updateReady: true, updateContentReady: true, canApplyUpdate: () => true, ready, connected: ready, status: { state: 'synced', label: 'Synced' }, attention: null, unsynced: false,
		onRefresh: async () => {}, onLogout: async () => {}, shortcut: null, issues: null,
		encryption: status ? { status, folderPath: 'Reading' } : undefined };
}
function render(readingState: SettingsSnapshot['reading'] = reading('unencrypted'), remindersConnected = true) {
	const markup = renderToStaticMarkup(React.createElement(React.Fragment, null,
		React.createElement(EncryptionSettings, { reading: readingState, remindersConnected }),
		React.createElement(EncryptionSetupHint, { reading: readingState })));
	return parseHTML(`<html><body>${markup}</body></html>`).document;
}
const statusRows = (document: Document) => [...document.querySelectorAll('.settings-group > .settings-row')].map(row => row.textContent);

beforeEach(() => vi.mocked(reminderEncryptionSnapshot).mockReturnValue({ status: 'unencrypted' }));

describe('settings encryption status', () => {
	it('replaces the status section with one setup hint while nothing is encrypted', () => {
		const document = render();
		expect(statusRows(document)).toEqual([]);
		expect(document.body.textContent?.match(/Encryption is off\. Set it up in Obsidian under Crate settings → Sync → Manage encryption\./g)).toHaveLength(1);
		expect(document.querySelector('details')).toBeNull();
	});
	it.each([[reading(undefined, false), true], [reading(), false]])('does not report unknown or disconnected encryption as disabled', (readingState, remindersConnected) => {
		vi.mocked(reminderEncryptionSnapshot).mockReturnValue({ status: 'checking' });
		const document = render(readingState, remindersConnected);
		expect(statusRows(document)).toEqual([]);
		expect(document.body.textContent).not.toContain('Not enabled');
		expect(document.body.textContent).not.toContain('Encryption is off');
	});
	it.each([false, true])('keeps lock and conversion problems visible without expanding details (converting=%s)', converting => {
		vi.mocked(reminderEncryptionSnapshot).mockReturnValue({ status: 'locked', message: 'Finish encryption in Obsidian.', converting, setupRequired: false });
		const document = render(reading('locked'));
		expect(statusRows(document)[0]).toContain(converting ? 'Converting' : 'Locked');
		expect(document.body.textContent).toContain('Finish encryption in Obsidian.');
		expect(document.body.textContent).toContain('Unlock or verify Reading in the app before using this folder.');
		expect(document.querySelector('details')).toBeNull();
	});
	it('retains folder, notification and privacy information behind the unlocked details', () => {
		vi.mocked(reminderEncryptionSnapshot).mockReturnValue({ status: 'ready', folderPath: 'Private reminders' });
		const document = render(reading('ready'));
		expect(statusRows(document)).toEqual(['RemindersUnlocked', 'ReadingUnlocked']);
		expect(document.body.textContent).not.toContain('Encryption is off');
		const details = document.querySelector('details')!;
		expect(details.hasAttribute('open')).toBe(false);
		for (const text of ['Private reminders', 'Encrypted Reading folder', 'Notification keys ready', 'The server can still see file paths']) expect(details.textContent).toContain(text);
	});
	it('keeps the two feature states independent', () => {
		const document = render(reading('ready'));
		expect(statusRows(document)).toEqual(['RemindersNot enabled', 'ReadingUnlocked']);
		expect(document.body.textContent).toContain('Encryption is off. Set it up in Obsidian under Crate settings → Sync → Manage encryption.');
		expect(document.querySelector('details')?.textContent).not.toContain('Notification keys ready');
	});
});
