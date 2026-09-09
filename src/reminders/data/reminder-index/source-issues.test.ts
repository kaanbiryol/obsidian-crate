import { afterEach, describe, expect, it, vi } from 'vitest';
import { createReminderByteVault } from '@/test/factories/reminder-byte-vault';
import { createReminderIndex } from './index';
import { createMarkdownWriter } from '../markdown-writer';

const a = 'Reminders/A.md';
const b = 'Reminders/B.md';
const task = '- [ ] Original <!-- crate-id:one -->\n';
const fixtures: Awaited<ReturnType<typeof createReminderByteVault>>[] = [];
async function workspace() {
	const h = await createReminderByteVault({ [a]: task, [b]: '- [ ] Other <!-- crate-id:two -->\n' });
	fixtures.push(h);
	const index = createReminderIndex(h.app, 'Reminders');
	await index.load();
	const read = h.vault.adapter.readBinary.getMockImplementation()!;
	h.vault.adapter.readBinary.mockImplementation(path => path === a ? Promise.reject(new Error('Temporary read failure')) : read(path));
	return { ...h, index, read };
}
afterEach(async () => { for (const h of fixtures.splice(0)) await h.dispose(); });

describe('incomplete reminder sources', () => {
	it('retains failed-file entries while updating healthy files, blocks stale edits, and clears the warning after recovery', async () => {
		const h = await workspace();
		const completedScan = h.index.lastScanTime;
		const listener = vi.fn();
		h.index.onIndexChange(listener);
		await h.put(b, '- [ ] Healthy update <!-- crate-id:two -->\n');
		const result = await h.index.load();
		expect(result.filesScanned).toBe(1);
		expect(result.issues).toEqual([{ path: a, reason: 'Temporary read failure' }]);
		expect(h.index.getAll().map(reminder => reminder.content).sort()).toEqual(['Healthy update', 'Original']);
		expect(h.index.isLoaded).toBe(true);
		expect(h.index.isComplete).toBe(false);
		expect(h.index.lastScanTime).toBe(completedScan);
		expect(listener).toHaveBeenCalledOnce();
		const writer = createMarkdownWriter(h.app, h.index);
		await expect(writer.updateReminder(h.index.getById('one')!, { content: 'Unsafe edit' })).rejects.toThrow('Refresh reminders');
		await writer.updateReminder(h.index.getById('two')!, { content: 'Safe edit' });
		expect(await h.readBytes(a)).toEqual(Buffer.from(task));
		h.vault.adapter.readBinary.mockImplementation(h.read);
		await h.put(a, task.replace('Original', 'Recovered update'));
		await h.index.load();
		expect(h.index.sourceIssues).toEqual([]);
		expect(h.index.isComplete).toBe(true);
		expect(h.index.getById('one')?.content).toBe('Recovered update');
	});

	it('publishes incremental failures, allows immediate retry, and clears issues on a confirmed deletion', async () => {
		const h = await workspace();
		const file = h.files.get(a)!;
		await h.index.rescanFile(file);
		expect(h.index.sourceIssues).toHaveLength(1);
		expect(h.index.getById('one')?.content).toBe('Original');
		h.vault.adapter.readBinary.mockImplementation(h.read);
		await h.index.rescanFile(file);
		expect(h.index.isComplete).toBe(true);
		h.vault.adapter.readBinary.mockRejectedValueOnce(new Error('Read failed again'));
		await h.index.rescanFile(file, true);
		await h.vault.adapter.remove(a);
		h.index.removeFile(a);
		expect(h.index.sourceIssues).toEqual([]);
		expect(h.index.getById('one')).toBeUndefined();
	});

	it('does not repair an ID against an unreadable previous owner during a full scan', async () => {
		const h = await workspace();
		await h.put(b, task);
		const before = await h.readBytes(b);
		await h.index.load();
		expect(h.index.sourceIssues.map(issue => issue.path).sort()).toEqual([a, b]);
		expect(h.index.getById('one')?.filePath).toBe(a);
		expect(h.index.getById('two')?.filePath).toBe(b);
		expect(await h.readBytes(b)).toEqual(before);
		expect(h.vault.process).not.toHaveBeenCalled();
	});

	it('moves warnings to the renamed path and clears them after a successful scan', async () => {
		const h = await workspace();
		await h.index.load();
		const renamed = 'Reminders/Renamed.md';
		await h.vault.adapter.rename(a, renamed);
		h.index.renameFile(a, renamed);
		expect(h.index.sourceIssues).toEqual([{ path: renamed, reason: 'Temporary read failure' }]);
		await h.index.rescanFile(h.files.get(renamed)!);
		expect(h.index.isComplete).toBe(true);
		expect(h.index.getById('one')?.filePath).toBe(renamed);
	});
});
