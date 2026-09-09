import { afterEach, describe, expect, it, vi } from 'vitest';
import { createReminderByteVault } from '@/test/factories/reminder-byte-vault';
import { scanFile } from './vaultScanner';
import { createReminderIndex } from './reminder-index';
import { createMarkdownWriter } from './markdown-writer';
import { createReminderMoveJournal } from './reminder-move-journal';

const source = 'Reminders/A.md';
const destination = 'Reminders/Z.md';
const task = '- [ ] Task <!-- crate-id:one -->\n';
const other = '- [ ] Other <!-- crate-id:two -->\n';
const malformed = Buffer.concat([Buffer.from('Unrelated: caf'), Buffer.from([0xe9]), Buffer.from(`\n${task}${other}`)]);
const fixtures: Awaited<ReturnType<typeof createReminderByteVault>>[] = [];
async function workspace(content: string | Uint8Array = task + other) {
	const h = await createReminderByteVault({ [source]: content, [destination]: '# Destination\n' });
	fixtures.push(h);
	const journal = createReminderMoveJournal(h.app, '.obsidian/plugins/crate/reminder-moves', 'Reminders');
	await journal.recover();
	const index = createReminderIndex(h.app, 'Reminders');
	await index.load();
	return { ...h, index, journal, writer: createMarkdownWriter(h.app, index, journal) };
}
afterEach(async () => { for (const h of fixtures.splice(0)) await h.dispose(); vi.restoreAllMocks(); });

describe('plugin reminder byte safety', () => {
	it.each([
		['invalid UTF-8', malformed],
		['null characters', Buffer.from(`Unrelated\0content\n${task}`)],
	])('refuses normalization of %s without rewriting any bytes', async (_name, bytes) => {
		const h = await workspace(bytes);
		expect(h.index.getAll()).toEqual([]);
		expect(h.index.sourceIssues).toEqual([expect.objectContaining({ path: source })]);
		expect(h.index.isComplete).toBe(false);
		expect(await h.readBytes(source)).toEqual(bytes);
		expect(h.vault.process).not.toHaveBeenCalled();
	});

	it.each(['create', 'update', 'toggle', 'delete', 'reorder', 'move source', 'move destination'] as const)('rejects %s after a previously valid note becomes malformed', async operation => {
		const h = await workspace();
		const reminder = h.index.getById('one')!;
		const affected = operation === 'move destination' ? destination : source;
		await h.put(affected, malformed);
		const before = await Promise.all([h.readBytes(source), h.readBytes(destination)]);
		const actions = {
			create: () => h.writer.createReminder('A', 'New', undefined, 4),
			update: () => h.writer.updateReminder(reminder, { content: 'Updated' }),
			toggle: () => h.writer.toggleComplete(reminder),
			delete: () => h.writer.deleteReminder(reminder),
			reorder: () => h.writer.reorderReminders(source, ['two', 'one']),
			'move source': () => h.writer.updateReminder(reminder, { project: 'Z' }),
			'move destination': () => h.writer.updateReminder(reminder, { project: 'Z' }),
		};
		await expect(actions[operation]()).rejects.toThrow('UTF-8');
		expect(await Promise.all([h.readBytes(source), h.readBytes(destination)])).toEqual(before);
		expect(h.vault.process).not.toHaveBeenCalled();
	});

	it('preserves a BOM, CRLF, Unicode and literal replacement characters when adopting and editing valid UTF-8', async () => {
		const prefix = '\uFEFFUnrelated: café 日本語 �\r\n\r\n';
		const h = await workspace(`${prefix}- [ ] Task\r\n`);
		expect(h.index.sourceIssues).toEqual([]);
		expect(h.index.getAll()).toHaveLength(1);
		const reminder = h.index.getAll()[0]!;
		await h.writer.updateReminder(reminder, { content: 'Edited' });
		expect((await h.readBytes(source)).subarray(0, Buffer.byteLength(prefix))).toEqual(Buffer.from(prefix));
		expect((await h.readBytes(source)).toString()).toContain('Edited');
	});

	it('defers normalization when the text changes after its raw-byte precheck', async () => {
		const h = await workspace();
		await h.put(source, '- [ ] Newly added\n');
		const changed = Buffer.from('A concurrent edit\n- [ ] Newly added\n');
		const process = h.vault.process.getMockImplementation()!;
		h.vault.process.mockImplementationOnce(async (file, update) => { await h.put(file.path, changed); return process(file, update); });
		const result = await scanFile(h.app, h.files.get(source)!, 'Reminders');
		expect(result.deferred).toBe(true);
		expect(await h.readBytes(source)).toEqual(changed);
	});

	it.each([source, destination])('keeps both notes and the recovery record when %s becomes unreadable after an interrupted move', async affected => {
		const h = await workspace();
		const lifetime = new AbortController();
		const directory = '.obsidian/plugins/crate/reminder-moves';
		const journal = createReminderMoveJournal(h.app, directory, 'Reminders', lifetime.signal);
		await journal.recover();
		const writer = createMarkdownWriter(h.app, h.index, journal);
		const process = h.vault.process.getMockImplementation()!;
		h.vault.process.mockImplementationOnce(async (file, update) => {
			await process(file, update); lifetime.abort(); throw new DOMException('Process stopped', 'AbortError');
		});
		await expect(writer.updateReminder(h.index.getById('one')!, { project: 'Z' })).rejects.toMatchObject({ name: 'AbortError' });
		await h.put(affected, Buffer.concat([await h.readBytes(affected), Buffer.from([0xe9])]));
		const before = await Promise.all([h.readBytes(source), h.readBytes(destination)]);
		const resumed = createReminderMoveJournal(h.app, directory, 'Reminders');
		expect(await resumed.recover()).not.toEqual([]);
		expect(resumed.hasPending()).toBe(true);
		expect((await h.vault.adapter.list(directory)).files.filter(path => path.endsWith('.json'))).toHaveLength(1);
		expect(await Promise.all([h.readBytes(source), h.readBytes(destination)])).toEqual(before);
	});
});
