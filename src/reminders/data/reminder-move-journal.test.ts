import { describe, expect, it, vi } from 'vitest';
import { TFile } from 'obsidian';
import { createMockAppWithVault } from '@/test/factories/obsidian';
import { createReminderMoveJournal } from './reminder-move-journal';
import { createReminderIndex } from './reminder-index';
import { createMarkdownWriter } from './markdown-writer';

const directory = '.obsidian/plugins/crate/reminder-moves';
const reminderFolder = 'Notes/Reminders';
const sourcePath = `${reminderFolder}/A.md`;
const destinationPath = `${reminderFolder}/Z.md`;
const task = '- [ ] Task <!-- crate-id:one -->\n<!-- crate-desc:v1:Important%20details -->';
const other = '- [ ] Other <!-- crate-id:other -->\n';

async function workspace() {
	const { app, files, folders, vault } = createMockAppWithVault({ [sourcePath]: `${task}\n${other}`, [destinationPath]: '# Z\n' });
	const adapter = Object.assign(app.vault.adapter, {
		exists: vi.fn(async (path: string) => files.has(path) || folders.has(path) || [...files.keys()].some(file => file.startsWith(`${path}/`))),
		list: vi.fn(async (path: string) => ({ files: [...files.keys()].filter(file => file.startsWith(`${path}/`)), folders: [] })),
		mkdir: vi.fn(async (path: string) => { folders.add(path); }),
		read: vi.fn(async (path: string) => { const content = files.get(path); if (content === undefined) throw new Error('Missing file'); return content; }),
		write: vi.fn(async (path: string, content: string) => { files.set(path, content); }),
		rename: vi.fn(async (from: string, to: string) => { const content = files.get(from); if (content === undefined) throw new Error('Missing temporary file'); files.set(to, content); files.delete(from); }),
		remove: vi.fn(async (path: string) => { files.delete(path); }),
	});
	async function session(folderPath = reminderFolder) {
		const lifetime = new AbortController();
		const journal = createReminderMoveJournal(app, directory, folderPath, lifetime.signal);
		const issues = await journal.recover();
		const index = createReminderIndex(app, folderPath, lifetime.signal, path => Boolean(path && journal.isPendingFile(path)), () => journal.hasPending());
		for (const path of [sourcePath, destinationPath]) {
			const file = app.vault.getAbstractFileByPath(path);
			if (file instanceof TFile) await index.rescanFile(file, true);
		}
		const writer = createMarkdownWriter(app, index, journal);
		writer.setOnFileWritten(written => index.rescanFile(written, true));
		return { journal, index, writer, lifetime, issues };
	}
	return { files, vault, adapter, session, first: await session(), records: () => [...files.keys()].filter(path => path.startsWith(directory) && path.endsWith('.json')) };
}

describe('durable plugin move recovery', () => {
	it.each(['destination', 'source'])('recovers with the same ID after process loss at the %s write boundary', async boundary => {
		const { files, vault, first, session, records } = await workspace();
		const normalProcess = vault.process.getMockImplementation()!;
		vault.process.mockImplementation(async (file, update) => {
			const content = await normalProcess(file, update);
			if (file.path === (boundary === 'destination' ? destinationPath : sourcePath)) {
				first.lifetime.abort();
				throw new DOMException('Simulated process termination', 'AbortError');
			}
			return content;
		});
		await expect(first.writer.updateReminder(first.index.getById('one')!, { project: 'Z' })).rejects.toMatchObject({ name: 'AbortError' });
		expect(records()).toHaveLength(1);
		vault.process.mockImplementation(normalProcess);
		const resumed = await session();
		expect(resumed.issues).toEqual([]);
		expect(records()).toEqual([]);
		expect(files.get(sourcePath)).toBe(other);
		expect(files.get(destinationPath)).toContain(task);
		expect(resumed.index.getById('one')?.filePath).toBe(destinationPath);
		expect(resumed.index.getAll().map(reminder => reminder.id).sort()).toEqual(['one', 'other']);
	});

	it('does not write either note before a verified journal has been published', async () => {
		const { adapter, files, vault, first, session, records } = await workspace();
		adapter.rename.mockRejectedValueOnce(new Error('Checkpoint rename failed'));
		await expect(first.writer.updateReminder(first.index.getById('one')!, { project: 'Z' })).rejects.toThrow('Checkpoint rename failed');
		expect(vault.process).not.toHaveBeenCalled();
		expect(files.get(sourcePath)).toBe(`${task}\n${other}`);
		expect(files.get(destinationPath)).toBe('# Z\n');
		expect(records()).toEqual([]);
		expect((await session()).index.getById('one')?.filePath).toBe(sourcePath);
	});

	it('cleans up a committed move after the journal-removal acknowledgement fails', async () => {
		const { adapter, first, session, records } = await workspace();
		adapter.remove.mockRejectedValueOnce(new Error('Checkpoint removal failed'));
		await expect(first.writer.updateReminder(first.index.getById('one')!, { project: 'Z' })).rejects.toThrow('Checkpoint removal failed');
		expect(records()).toHaveLength(1);
		const resumed = await session();
		expect(resumed.issues).toEqual([]);
		expect(resumed.index.getById('one')?.filePath).toBe(destinationPath);
		expect(records()).toEqual([]);
	});

	it.each(['destination', 'source'])('preserves the destination when the %s write commits but its acknowledgement fails', async boundary => {
		const { files, vault, first, session, records } = await workspace();
		const normalProcess = vault.process.getMockImplementation()!;
		let failed = false;
		vault.process.mockImplementation(async (file, update) => {
			const content = await normalProcess(file, update);
			if (!failed && file.path === (boundary === 'destination' ? destinationPath : sourcePath)) {
				failed = true;
				throw new Error('Durable write acknowledgement lost');
			}
			return content;
		});
		await expect(first.writer.updateReminder(first.index.getById('one')!, { project: 'Z' }))
			.rejects.toThrow('Durable write acknowledgement lost');
		expect(files.get(destinationPath)).toContain(task);
		expect(records()).toHaveLength(boundary === 'destination' ? 1 : 0);
		vault.process.mockImplementation(normalProcess);
		const recovered = await session();
		expect(recovered.issues).toEqual([]);
		expect(files.get(sourcePath)).toBe(other);
		expect(files.get(destinationPath)).toContain(task);
		expect(recovered.index.getById('one')?.filePath).toBe(destinationPath);
		expect(records()).toEqual([]);
	});

	it('recovers a published preparation when its acknowledgement is lost before either note is written', async () => {
		const { adapter, files, vault, first, session, records } = await workspace();
		const read = adapter.read.getMockImplementation()!;
		adapter.read.mockImplementation(async path => {
			if (path.endsWith('.json')) throw new Error('Published checkpoint response lost');
			return read(path);
		});
		await expect(first.writer.updateReminder(first.index.getById('one')!, { project: 'Z' })).rejects.toThrow('Published checkpoint response lost');
		expect(records()).toHaveLength(1);
		expect(vault.process).not.toHaveBeenCalled();
		adapter.read.mockImplementation(read);
		const resumed = await session();
		expect(resumed.issues).toEqual([]);
		expect(records()).toEqual([]);
		expect(files.get(sourcePath)).toBe(`${task}\n${other}`);
		expect(files.get(destinationPath)).toBe('# Z\n');
	});

	it.each(['unrelated source edit', 'changed source task', 'both tasks changed'])('preserves concurrent content during recovery: %s', async edit => {
		const { files, vault, first, session, records } = await workspace();
		const normalProcess = vault.process.getMockImplementation()!;
		vault.process.mockImplementationOnce(async (file, update) => {
			const content = await normalProcess(file, update);
			first.lifetime.abort(); throw new DOMException(content, 'AbortError');
		});
		await expect(first.writer.updateReminder(first.index.getById('one')!, { project: 'Z' })).rejects.toMatchObject({ name: 'AbortError' });
		files.set(sourcePath, files.get(sourcePath)!.replace(edit === 'unrelated source edit' ? 'Other' : 'Task', 'New local text'));
		if (edit === 'both tasks changed') files.set(destinationPath, files.get(destinationPath)!.replace('Task', 'New destination text'));
		const beforeSource = files.get(sourcePath)!;
		const beforeDestination = files.get(destinationPath)!;
		const resumed = await session();
		if (edit === 'both tasks changed') {
			expect(resumed.issues.join()).toContain('Recover interrupted reminder moves');
			expect(files.get(sourcePath)).toBe(beforeSource);
			expect(files.get(destinationPath)).toBe(beforeDestination);
			expect(records()).toHaveLength(1);
			await expect(resumed.writer.updateReminder(first.index.getById('one')!, { content: 'Unsafe overwrite' })).rejects.toThrow('needs review');
			// The user merges/keeps the wanted text and removes the other copy in Markdown.
			files.set(sourcePath, other);
			expect(await resumed.journal.recover()).toEqual([]);
			expect(files.get(destinationPath)).toBe(beforeDestination);
			expect(records()).toEqual([]);
		} else {
			expect(resumed.issues).toEqual([]);
			expect(records()).toEqual([]);
			if (edit === 'unrelated source edit') {
				expect(files.get(sourcePath)).toBe(other.replace('Other', 'New local text'));
				expect(files.get(destinationPath)).toBe(beforeDestination);
			} else {
				expect(files.get(sourcePath)).toBe(beforeSource);
				expect(files.get(destinationPath)).not.toContain('crate-id:one');
			}
		}
	});

	it('keeps unknown recovery data and blocks repair if a journal record is damaged', async () => {
		const { files, session, first } = await workspace();
		files.set(`${directory}/broken.json`, '{partial');
		const resumed = await session();
		expect(resumed.issues.join()).toContain('could not be read');
		expect(resumed.journal.hasPending()).toBe(true);
		await expect(resumed.writer.updateReminder(first.index.getById('one')!, { project: 'Z' })).rejects.toThrow('recovery records');
		expect(files.get(sourcePath)).toBe(`${task}\n${other}`);
		expect(files.get(`${directory}/broken.json`)).toBe('{partial');
	});

	it('keeps the source and recovery record if the destination disappears during recovery', async () => {
		const { files, vault, first, session, records } = await workspace();
		const normalProcess = vault.process.getMockImplementation()!;
		vault.process.mockImplementationOnce(async (file, update) => {
			await normalProcess(file, update); first.lifetime.abort(); throw new DOMException('Process stopped', 'AbortError');
		});
		await expect(first.writer.updateReminder(first.index.getById('one')!, { project: 'Z' })).rejects.toMatchObject({ name: 'AbortError' });
		vault.process.mockImplementationOnce(async (file, update) => {
			files.delete(destinationPath);
			return normalProcess(file, update);
		});
		const resumed = await session();
		expect(resumed.issues.join()).toContain('changed during recovery');
		expect(files.get(sourcePath)).toBe(`${task}\n${other}`);
		expect(records()).toHaveLength(1);
	});

	it.each(['not indexed', 'broader folder'])('preserves pending ownership when recovery sees an existing note through %s', async condition => {
		const { files, vault, first, session, records } = await workspace();
		const normalProcess = vault.process.getMockImplementation()!;
		vault.process.mockImplementationOnce(async (file, update) => {
			await normalProcess(file, update); first.lifetime.abort(); throw new DOMException('Process stopped', 'AbortError');
		});
		await expect(first.writer.updateReminder(first.index.getById('one')!, { project: 'Z' })).rejects.toMatchObject({ name: 'AbortError' });
		const beforeSource = files.get(sourcePath);
		const beforeDestination = files.get(destinationPath);
		const getFile = vault.getAbstractFileByPath.getMockImplementation()!;
		if (condition === 'not indexed') vault.getAbstractFileByPath.mockImplementation(path => path === sourcePath ? null : getFile(path));
		const resumed = await session(condition === 'broader folder' ? 'Notes' : reminderFolder);
		expect(resumed.issues.join()).toContain(condition === 'broader folder' ? 'Switch the reminder folder back' : 'not indexed yet');
		expect(resumed.journal.isPendingFile(sourcePath)).toBe(true);
		expect(resumed.journal.isPendingFile(destinationPath)).toBe(true);
		expect(records()).toHaveLength(1);
		expect(files.get(sourcePath)).toBe(beforeSource);
		expect(files.get(destinationPath)).toBe(beforeDestination);
		vault.getAbstractFileByPath.mockImplementation(getFile);
		const recovered = await session();
		expect(recovered.issues).toEqual([]);
		expect(records()).toEqual([]);
		expect(recovered.index.getById('one')?.filePath).toBe(destinationPath);
	});
});
