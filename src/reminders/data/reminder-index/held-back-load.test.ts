import { afterEach, expect, it } from 'vitest';
import { TFile } from 'obsidian';
import { createReminderByteVault } from '@/test/factories/reminder-byte-vault';
import { createReminderIndex } from './index';

const pending = 'Reminders/Pending.md', synced = 'Reminders/Synced.md', broken = 'Reminders/Broken.md';
const fixtures: Array<{ dispose(): Promise<void> }> = [];
afterEach(async () => { for (const fixture of fixtures.splice(0)) await fixture.dispose(); });

async function workspace() {
	const h = await createReminderByteVault({
		[pending]: '- [ ] Moving <!-- crate-id:moving -->\n',
		[synced]: '- [ ] Before <!-- crate-id:synced -->\n',
		[broken]: '- [ ] Broken <!-- crate-id:broken -->\n<!-- crate-desc:v9:unknown -->\n',
	});
	fixtures.push(h);
	let syncing = false;
	// A move record awaiting review keeps its note deferred until it is resolved.
	const index = createReminderIndex(h.app, 'Reminders', { shouldDeferScan: path => syncing || path === pending });
	const file = (path: string) => {
		const current = h.app.vault.getAbstractFileByPath(path);
		if (!(current instanceof TFile)) throw new Error('Test file is missing');
		return current;
	};
	await index.load();
	return { ...h, index, file, setSyncing: (next: boolean) => { syncing = next; } };
}

it('publishes synced edits after sync while another note stays deferred', async () => {
	const { put, index, file, setSyncing } = await workspace();
	expect(index.isInitialLoadComplete).toBe(true);
	expect(index.getById('moving')?.filePath).toBe(pending);
	setSyncing(true);
	await put(synced, '- [ ] After <!-- crate-id:synced -->\n');
	await index.rescanFile(file(synced));
	setSyncing(false);
	await index.flushDeferredScans();
	expect(index.getById('synced')?.content).toBe('After');
	expect(index.getById('moving')?.filePath).toBe(pending);
});

it('clears a repaired note issue on refresh while another note stays deferred', async () => {
	const { put, index } = await workspace();
	expect(index.sourceIssues.map(issue => issue.path)).toEqual([broken]);
	await put(broken, '- [ ] Broken <!-- crate-id:broken -->\n');
	await index.load();
	expect(index.sourceIssues).toEqual([]);
	expect(index.getById('broken')).toBeDefined();
});
