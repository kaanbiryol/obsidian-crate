import { describe, expect, it, vi } from 'vitest';
import { TFile, TFolder } from 'obsidian';
import { createMockAppWithVault } from '@/test/factories/obsidian';
import { createMarkdownWriter } from '../markdown-writer';
import { createReminderIndex } from './index';

const task = '- [ ] Task <!-- crate-id:stable-id -->\n<!-- crate-desc:v1:Important%20details -->\n';
const unrelated = '- [ ] Unrelated <!-- crate-id:unrelated -->\n';

async function workspace(source = 'A', destination = 'Z') {
	const sourcePath = `Reminders/${source}.md`;
	const destinationPath = `Reminders/${destination}.md`;
	const { app, files, vault, folders } = createMockAppWithVault({ [sourcePath]: task + unrelated, [destinationPath]: '# Project\n' });
	folders.add('Reminders');
	const lifetime = new AbortController();
	let status = 'idle';
	const index = createReminderIndex(app, 'Reminders', lifetime.signal, () => status === 'syncing', () => status === 'error' || status === 'offline');
	function file(path: string): TFile {
		const current = app.vault.getAbstractFileByPath(path);
		if (!(current instanceof TFile)) throw new Error('Test file is missing');
		return current;
	}
	await index.rescanFile(file(sourcePath), true);
	await index.rescanFile(file(destinationPath), true);
	const writer = createMarkdownWriter(app, index);
	writer.setOnFileWritten(written => index.rescanFile(written, true));
	return { app, files, vault, index, writer, file, sourcePath, destinationPath, lifetime, setStatus: (next: string) => { status = next; } };
}

describe('reminder identity ownership during moves', () => {
	it.each([['A', 'Z'], ['Z', 'A']])('keeps the stable ID through the real writer and index moving %s to %s', async (source, destination) => {
		const { files, index, writer, sourcePath, destinationPath } = await workspace(source, destination);
		const reminder = index.getById('stable-id');
		if (!reminder) throw new Error('Test reminder is missing');

		await writer.updateReminder(reminder, { project: destination });

		expect(files.get(sourcePath)).toBe(unrelated);
		expect(files.get(destinationPath)).toContain(task);
		expect(index.getAll().map(item => item.id).sort()).toEqual(['stable-id', 'unrelated']);
		expect(index.getById('stable-id')).toMatchObject({ filePath: destinationPath, project: destination, description: 'Important details' });
		expect(index.getByFile(sourcePath).map(item => item.id)).toEqual(['unrelated']);
	});

	it.each(['source first', 'destination first', 'concurrent'])('reconciles an externally moved reminder against current bytes with %s scans', async order => {
		const { app, files, index, file, sourcePath, destinationPath } = await workspace();
		// A cached read is deliberately stale; ownership decisions use vault.read.
		const cachedRead = vi.fn(async () => task + unrelated);
		app.vault.cachedRead = cachedRead;
		files.set(sourcePath, unrelated);
		files.set(destinationPath, task);
		const sourceScan = () => index.rescanFile(file(sourcePath), true);
		const destinationScan = () => index.rescanFile(file(destinationPath), true);
		if (order === 'concurrent') await Promise.all([destinationScan(), sourceScan()]);
		else if (order === 'source first') { await sourceScan(); await destinationScan(); }
		else { await destinationScan(); await sourceScan(); }

		expect(files.get(destinationPath)).toBe(task);
		expect(index.getById('stable-id')?.filePath).toBe(destinationPath);
		expect(index.getAll()).toHaveLength(2);
		expect(cachedRead).not.toHaveBeenCalled();
	});

	it('keeps destination ownership when source deletion reaches the index later', async () => {
		const { files, index, file, sourcePath, destinationPath } = await workspace();
		files.delete(sourcePath);
		files.set(destinationPath, task);
		await index.rescanFile(file(destinationPath), true);
		index.removeFile(sourcePath);

		expect(files.get(destinationPath)).toBe(task);
		expect(index.getById('stable-id')?.filePath).toBe(destinationPath);
	});

	it.each([['A', 'Z'], ['Z', 'A']])('still assigns a fresh ID to a genuine duplicate from %s into %s', async (source, destination) => {
		const { files, index, file, sourcePath, destinationPath } = await workspace(source, destination);
		files.set(destinationPath, task.replace('Task', 'Pasted task'));
		await index.rescanFile(file(destinationPath), true);

		expect(files.get(sourcePath)).toBe(task + unrelated);
		expect(files.get(destinationPath)).not.toContain('crate-id:stable-id');
		expect(index.getById('stable-id')?.filePath).toBe(sourcePath);
		expect(new Set(index.getAll().map(item => item.id)).size).toBe(3);
	});

	it('does not rewrite a possible duplicate when its current owner cannot be read', async () => {
		const { files, vault, index, file, sourcePath, destinationPath } = await workspace();
		files.set(destinationPath, task);
		vault.read.mockImplementation(async current => {
			if (current.path === sourcePath) throw new Error('Owner temporarily unreadable');
			return files.get(current.path) ?? '';
		});
		await index.rescanFile(file(destinationPath), true);

		expect(files.get(destinationPath)).toBe(task);
		expect(vault.process).not.toHaveBeenCalled();
		expect(index.getById('stable-id')?.filePath).toBe(sourcePath);
	});

	it.each(['idle', 'error', 'offline'])('preserves incoming destination-before-source moves when sync ends %s', async finalStatus => {
		const { files, index, file, sourcePath, destinationPath, setStatus } = await workspace();
		setStatus('syncing');
		files.set(destinationPath, task);
		await index.rescanFile(file(destinationPath), true);
		expect(files.get(destinationPath)).toBe(task);
		if (finalStatus !== 'idle') {
			setStatus(finalStatus);
			await index.flushDeferredScans();
			expect(files.get(destinationPath)).toBe(task);
			expect(index.getById('stable-id')?.filePath).toBe(sourcePath);
			setStatus('syncing');
		}
		files.set(sourcePath, unrelated);
		await index.rescanFile(file(sourcePath), true);
		setStatus('idle');
		await index.flushDeferredScans();

		expect(files.get(destinationPath)).toBe(task);
		expect(index.getById('stable-id')?.filePath).toBe(destinationPath);
		expect(index.getAll()).toHaveLength(2);
	});

	it('retains local edits received during sync and cancels deferred normalization on unload', async () => {
		const { files, index, file, sourcePath, destinationPath, setStatus, lifetime } = await workspace();
		setStatus('syncing');
		files.set(sourcePath, unrelated.replace('Unrelated', 'Locally edited'));
		files.set(destinationPath, task + '- [ ] Local new task\n');
		await Promise.all([index.rescanFile(file(sourcePath), true), index.rescanFile(file(destinationPath), true)]);
		lifetime.abort();
		setStatus('idle');
		await index.flushDeferredScans();

		expect(files.get(sourcePath)).toContain('Locally edited');
		expect(files.get(destinationPath)).toBe(task + '- [ ] Local new task\n');
	});

	it('applies local edits and adopts new tasks after a successful sync finishes', async () => {
		const { files, index, file, sourcePath, destinationPath, setStatus } = await workspace();
		setStatus('syncing');
		files.set(sourcePath, unrelated.replace('Unrelated', 'Locally edited'));
		files.set(destinationPath, task + '- [ ] Local new task\n');
		await Promise.all([index.rescanFile(file(sourcePath), true), index.rescanFile(file(destinationPath), true)]);
		setStatus('idle');
		await index.flushDeferredScans();

		expect(index.getById('stable-id')?.filePath).toBe(destinationPath);
		expect(index.getById('unrelated')?.content).toBe('Locally edited');
		expect(index.getAll().find(reminder => reminder.content === 'Local new task')?.id).toBeDefined();
		expect(index.getAll()).toHaveLength(3);
	});

	it('defers normalization if synchronization starts during a file read', async () => {
		const { files, vault, index, file, sourcePath, destinationPath, setStatus } = await workspace();
		files.set(destinationPath, task);
		vault.read.mockImplementationOnce(async current => {
			setStatus('syncing');
			return files.get(current.path) ?? '';
		});
		await index.rescanFile(file(destinationPath), true);
		expect(files.get(destinationPath)).toBe(task);
		files.set(sourcePath, unrelated);
		setStatus('idle');
		await index.flushDeferredScans();
		expect(index.getById('stable-id')?.filePath).toBe(destinationPath);
		expect(files.get(destinationPath)).toBe(task);
	});

	it('rechecks owner existence inside the target atomic write callback', async () => {
		const { files, vault, index, file, sourcePath, destinationPath } = await workspace();
		files.set(destinationPath, task);
		vault.process.mockImplementationOnce(async (target, update) => {
			// The source is removed after ownership was read but before the target
			// mutation runs. Its formerly reserved ID must not be rewritten.
			files.delete(sourcePath);
			const next = update(files.get(target.path) ?? '');
			files.set(target.path, next);
			return next;
		});
		await index.rescanFile(file(destinationPath), true);
		expect(files.get(destinationPath)).toBe(task);
		await index.flushDeferredScans();
		expect(files.get(destinationPath)).toBe(task);
		expect(index.getById('stable-id')?.filePath).toBe(destinationPath);
	});

	it('rechecks ownership when a concurrent target edit introduces another owned identity', async () => {
		const { files, vault, index, file, sourcePath, destinationPath } = await workspace();
		files.set(destinationPath, '- [ ] New task\n');
		const concurrentContent = task + '- [ ] New task\n';
		vault.process.mockImplementationOnce(async (target, update) => {
			files.set(target.path, concurrentContent);
			const next = update(concurrentContent);
			files.set(target.path, next);
			return next;
		});
		await index.rescanFile(file(destinationPath), true);
		expect(files.get(destinationPath)).toBe(concurrentContent);
		expect(index.getById('stable-id')?.filePath).toBe(sourcePath);
		await index.flushDeferredScans();
		expect(files.get(destinationPath)).not.toContain('crate-id:stable-id');
		expect(index.getById('stable-id')?.filePath).toBe(sourcePath);
		expect(new Set(index.getAll().map(reminder => reminder.id)).size).toBe(4);
	});

	it('keeps healthy reminders visible on startup while withholding ambiguous owners until sync', async () => {
		const { app, files } = createMockAppWithVault({
			'Reminders/A.md': task + unrelated,
			'Reminders/B.md': task,
			'Reminders/Z.md': '- [ ] Healthy task <!-- crate-id:healthy -->\n',
		});
		const entries = [...files.keys()].map(path => app.vault.getAbstractFileByPath(path)).filter((entry): entry is TFile => entry instanceof TFile);
		app.vault.getAbstractFileByPath = path => path === 'Reminders'
			? Object.assign(new TFolder(), { path, children: entries })
			: entries.find(entry => entry.path === path) ?? null;
		let waitingForSync = true;
		const index = createReminderIndex(app, 'Reminders', undefined, () => false, () => waitingForSync);
		const result = await index.load();

		expect(result.deferred).toBe(true);
		expect(index.getAll().map(reminder => reminder.id).sort()).toEqual(['healthy', 'unrelated']);
		expect(files.get('Reminders/A.md')).toBe(task + unrelated);
		expect(files.get('Reminders/B.md')).toBe(task);
		const duplicateFile = entries.find(entry => entry.path === 'Reminders/B.md');
		if (!duplicateFile) throw new Error('Test duplicate file is missing');
		await index.rescanFile(duplicateFile, true);
		expect(index.getById('stable-id')).toBeUndefined();
		expect(files.get('Reminders/B.md')).toBe(task);
		files.set('Reminders/A.md', unrelated);
		waitingForSync = false;
		await index.flushDeferredScans();
		expect(index.getById('stable-id')?.filePath).toBe('Reminders/B.md');
		expect(index.getAll()).toHaveLength(3);
	});
});
