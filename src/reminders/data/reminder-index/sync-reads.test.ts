import { afterEach, expect, it } from 'vitest';
import { TFile } from 'obsidian';
import { createReminderByteVault } from '@/test/factories/reminder-byte-vault';
import { createReminderIndex } from './index';

const named = 'Reminders/Named.md', typed = 'Reminders/Typed.md', later = 'Reminders/Later.md';
const fixtures: Array<{ dispose(): Promise<void> }> = [];
afterEach(async () => { for (const fixture of fixtures.splice(0)) await fixture.dispose(); });

/** The production split: reads never wait for sync; writes wait while it may change vault files. */
async function workspace(initial: Record<string, string>) {
	const h = await createReminderByteVault(initial);
	fixtures.push(h);
	let writingVault = false;
	const index = createReminderIndex(h.app, 'Reminders', { shouldDeferWrites: () => writingVault });
	const file = (path: string) => {
		const current = h.app.vault.getAbstractFileByPath(path);
		if (!(current instanceof TFile)) throw new Error('Test file is missing');
		return current;
	};
	const reads = (path: string) => h.vault.adapter.readBinary.mock.calls.filter(([read]) => read === path).length;
	return { ...h, index, file, reads, setWritingVault: (next: boolean) => { writingVault = next; } };
}

it('loads reminders while sync changes vault files and writes held IDs after it', async () => {
	const { index, readBytes, setWritingVault } = await workspace({
		[named]: '- [ ] Named <!-- crate-id:named -->\n- [ ] Typed during sync\n',
	});
	setWritingVault(true);
	await index.load();

	// Before: the whole load waited, so the list stayed empty and loading until sync ended.
	expect(index.isInitialLoadComplete).toBe(true);
	expect(index.getAll().map(reminder => reminder.content)).toEqual(['Named']);
	expect((await readBytes(named)).toString()).not.toContain('Typed during sync <!-- crate-id:');

	setWritingVault(false);
	await index.flushDeferredScans();
	expect((await readBytes(named)).toString()).toMatch(/Typed during sync <!-- crate-id:[^ ]+ -->/);
	expect(index.getAll().map(reminder => reminder.content).sort()).toEqual(['Named', 'Typed during sync']);
});

it('keeps scanning when sync starts mid-load instead of restarting the folder scan', async () => {
	const { index, vault, reads, setWritingVault } = await workspace({
		[named]: '- [ ] Named <!-- crate-id:named -->\n',
		[typed]: '- [ ] Typed\n',
		[later]: '- [ ] Later <!-- crate-id:later -->\n',
	});
	const read = vault.adapter.readBinary.getMockImplementation()!;
	vault.adapter.readBinary.mockImplementation(async path => {
		if (path === named) setWritingVault(true); // A sync starts after the first note is read.
		return read(path);
	});
	await index.load();
	expect(index.isInitialLoadComplete).toBe(true);
	expect(index.getAll().map(reminder => reminder.id).sort()).toEqual(['later', 'named']);
	expect([named, typed, later].map(reads)).toEqual([1, 1, 1]);

	setWritingVault(false);
	await index.flushDeferredScans();
	// Only the note whose ID waited is read again, to write it.
	expect([named, later].map(reads)).toEqual([1, 1]);
	expect(index.getAll()).toHaveLength(3);
});

it('applies a note sync downloads at once when it needs no write', async () => {
	const { index, put, file, setWritingVault } = await workspace({ [named]: '- [ ] Named <!-- crate-id:named -->\n' });
	await index.load();
	setWritingVault(true);
	await put(later, '- [ ] Downloaded <!-- crate-id:downloaded -->\n');
	await index.rescanFile(file(later));
	expect(index.getById('downloaded')?.content).toBe('Downloaded');
});
