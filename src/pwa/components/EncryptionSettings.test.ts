import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { parseHTML } from 'linkedom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { encryptionSnapshot } from '../encryption-session';
import type { SettingsSnapshot } from '../settings-store';
import { EncryptionSettings } from './EncryptionSettings';

vi.mock('../encryption-session', () => ({ encryptionSnapshot: vi.fn(), subscribeEncryption: vi.fn() }));
vi.mock('react', async importOriginal => ({
	...await importOriginal<typeof import('react')>(),
	useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot(),
}));

function reading(status?: 'legacy' | 'ready' | 'locked', ready = true): SettingsSnapshot['reading'] {
	return { updateReady: true, updateContentReady: true, canApplyUpdate: () => true, ready, connected: ready, status: { state: 'synced', label: 'Synced' }, attention: null, unsynced: false,
		onRefresh: async () => {}, onLogout: async () => {}, shortcut: null, issues: null,
		encryption: status ? { status, folderPath: 'Reading' } : undefined };
}
function render(readingState: SettingsSnapshot['reading'] = reading('legacy'), remindersConnected = true) {
	const markup = renderToStaticMarkup(React.createElement(EncryptionSettings, { reading: readingState, remindersConnected }));
	return parseHTML(`<html><body>${markup}</body></html>`).document;
}
const statusRows = (document: Document) => [...document.querySelectorAll('.settings-group > .settings-row')].map(row => row.textContent);

beforeEach(() => vi.mocked(encryptionSnapshot).mockReturnValue({ status: 'legacy' }));

describe('settings encryption status', () => {
	it('shows one setup explanation for two unencrypted features', () => {
		const document = render();
		expect(statusRows(document)).toEqual(['RemindersNot enabled', 'ReadingNot enabled']);
		expect(document.body.textContent?.match(/Set up encryption in Crate in Obsidian\./g)).toHaveLength(1);
		expect(document.querySelector('details')).toBeNull();
	});
	it('does not report unknown encryption as disabled', () => {
		vi.mocked(encryptionSnapshot).mockReturnValue({ status: 'checking' });
		const document = render(reading(undefined, false));
		expect(statusRows(document)).toEqual(['RemindersChecking…', 'ReadingChecking…']);
		expect(document.body.textContent).not.toContain('Not enabled');
		expect(document.body.textContent).not.toContain('Set up encryption');
	});
	it('keeps connection guidance when a feature is disconnected', () => {
		vi.mocked(encryptionSnapshot).mockReturnValue({ status: 'checking' });
		const document = render(reading(), false);
		expect(document.querySelectorAll('.settings-value')).toHaveLength(2);
		expect(document.body.textContent).toContain('Connect Reminders to check this device.');
		expect(document.body.textContent).toContain('Connect Reading to check this device.');
	});
	it.each([false, true])('keeps lock and conversion problems visible without expanding details (converting=%s)', converting => {
		vi.mocked(encryptionSnapshot).mockReturnValue({ status: 'locked', message: 'Finish encryption in Obsidian.', converting, setupRequired: false });
		const document = render(reading('locked'));
		expect(statusRows(document)[0]).toContain(converting ? 'Converting' : 'Locked');
		expect(document.body.textContent).toContain('Finish encryption in Obsidian.');
		expect(document.body.textContent).toContain('Unlock or verify Reading in the app before using this folder.');
		expect(document.querySelector('details')).toBeNull();
	});
	it('retains folder, notification and privacy information behind the unlocked details', () => {
		vi.mocked(encryptionSnapshot).mockReturnValue({ status: 'ready', folderPath: 'Private reminders' });
		const document = render(reading('ready'));
		expect(statusRows(document)).toEqual(['RemindersUnlocked', 'ReadingUnlocked']);
		const details = document.querySelector('details')!;
		expect(details.hasAttribute('open')).toBe(false);
		for (const text of ['Private reminders', 'Encrypted Reading folder', 'Notification keys ready', 'The server can still see file paths']) expect(details.textContent).toContain(text);
		expect(document.body.textContent).not.toContain('Set up encryption');
	});
	it('keeps the two feature states independent', () => {
		const document = render(reading('ready'));
		expect(statusRows(document)).toEqual(['RemindersNot enabled', 'ReadingUnlocked']);
		expect(document.body.textContent).toContain('Set up encryption in Crate in Obsidian.');
		expect(document.querySelector('details')?.textContent).not.toContain('Notification keys ready');
	});
});
