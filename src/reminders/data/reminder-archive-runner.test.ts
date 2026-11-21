import { describe, expect, it, vi } from 'vitest';
import { TFile } from 'obsidian';
import { createMockAppWithVault } from '@/test/factories/obsidian';
import { createReminderMoveJournal } from './reminder-move-journal';
import { createReminderIndex } from './reminder-index';
import { archiveCompletedReminders, notesWithCompletedReminders } from './reminder-archive-runner';

const directory = '.obsidian/plugins/crate/reminder-moves';
const folder = 'Reminders';
const inbox = `${folder}/Inbox.md`;
const work = `${folder}/Work/Q1.md`;
const inboxArchive = `${folder}/Archive/Inbox.md`;
const done = (id: string, title = `Done ${id}`) => `- [x] ${title} <!-- crate-id:${id} -->`;
const open = (id: string) => `- [ ] Open ${id} <!-- crate-id:${id} -->`;

async function workspace(initial: Record<string, string>) {
	const { app, files, folders, vault } = createMockAppWithVault(initial);
	Object.assign(app.vault.adapter, {
		exists: vi.fn(async (path: string) => files.has(path) || folders.has(path) || [...files.keys()].some(file => file.startsWith(`${path}/`))),
		list: vi.fn(async (path: string) => ({ files: [...files.keys()].filter(file => file.startsWith(`${path}/`)), folders: [] })),
		mkdir: vi.fn(async (path: string) => { folders.add(path); }),
		read: vi.fn(async (path: string) => { const content = files.get(path); if (content === undefined) throw new Error('Missing file'); return content; }),
		write: vi.fn(async (path: string, content: string) => { files.set(path, content); }),
		rename: vi.fn(async (from: string, to: string) => { files.set(to, files.get(from)!); files.delete(from); }),
		remove: vi.fn(async (path: string) => { files.delete(path); }),
	});
	async function session() {
		const lifetime = new AbortController();
		const journal = createReminderMoveJournal(app, directory, folder, lifetime.signal);
		const issues = await journal.recover();
		const index = createReminderIndex(app, folder, { signal: lifetime.signal, shouldDeferScan: path => Boolean(path && journal.isPendingFile(path)) });
		for (const path of [...files.keys()].filter(path => path.startsWith(`${folder}/`))) {
			const file = app.vault.getAbstractFileByPath(path);
			if (file instanceof TFile) await index.rescanFile(file);
		}
		const archive = (paths: string[], isWritingVault = () => false) => archiveCompletedReminders({ app, index, journal, isWritingVault }, paths);
		return { journal, index, lifetime, issues, archive };
	}
	return { files, vault, session, records: () => [...files.keys()].filter(path => path.startsWith(directory) && path.endsWith('.json')) };
}

describe('archiveCompletedReminders', () => {
	it('moves completed reminders from every chosen note into matching archive notes', async () => {
		const { files, session, records } = await workspace({
			[inbox]: `# Inbox\n\n${open('a')}\n${done('b')}\n${done('c')}\n`,
			[work]: `${done('w')}\n${open('x')}\n`,
		});
		const { index, archive } = await session();
		expect(notesWithCompletedReminders(index.getAll())).toEqual([inbox, work]);
		await expect(archive([inbox, work])).resolves.toEqual({ archived: 3, skipped: 0, notes: 2, failures: [], deferred: false });
		expect(files.get(inbox)).toBe(`# Inbox\n\n${open('a')}\n`);
		expect(files.get(inboxArchive)).toBe(`${done('b')}\n${done('c')}\n`);
		expect(files.get(`${folder}/Archive/Work/Q1.md`)).toBe(`${done('w')}\n`);
		expect(records()).toEqual([]);
		// Archived reminders leave the index, and archive notes are never indexed.
		expect(index.getAll().map(reminder => reminder.id).sort()).toEqual(['a', 'x']);
		expect(index.isReminderFile(inboxArchive)).toBe(false);
	});

	it('appends a later run and keeps one archived copy per reminder', async () => {
		const { files, session } = await workspace({
			[inbox]: `${open('a')}\n${done('b', 'Again')}\n`,
			[inboxArchive]: `${done('b', 'First time')}\n${done('old')}\n`,
		});
		const { archive } = await session();
		await expect(archive([inbox])).resolves.toMatchObject({ archived: 1, skipped: 0 });
		expect(files.get(inbox)).toBe(`${open('a')}\n`);
		expect(files.get(inboxArchive)).toBe(`${done('old')}\n${done('b', 'Again')}\n`);
	});

	it('reports reminders that stay in place', async () => {
		const { files, session } = await workspace({ [inbox]: `${done('parent')}\n\t${open('sub')}\n${done('b')}\n` });
		const { archive } = await session();
		await expect(archive([inbox])).resolves.toEqual({ archived: 1, skipped: 1, notes: 1, failures: [], deferred: false });
		expect(files.get(inbox)).toBe(`${done('parent')}\n\t${open('sub')}\n`);
	});

	it('stops before the next note once sync writes the vault and reports what it archived', async () => {
		const { files, vault, session } = await workspace({ [inbox]: `${done('b')}\n`, [work]: `${done('w')}\n` });
		const { archive } = await session();
		let writing = false;
		const normalProcess = vault.process.getMockImplementation()!;
		vault.process.mockImplementation(async (file, update) => {
			const content = await normalProcess(file, update);
			if (file.path === inbox) writing = true;
			return content;
		});
		await expect(archive([inbox, work], () => writing))
			.resolves.toEqual({ archived: 1, skipped: 0, notes: 1, failures: [], deferred: true });
		expect(files.get(inbox)).toBe('');
		expect(files.get(work)).toBe(`${done('w')}\n`);
	});

	it.each(['archive', 'project'])('recovers after the process stops once the %s note is written', async boundary => {
		const { files, vault, session, records } = await workspace({ [inbox]: `${open('a')}\n${done('b')}\n` });
		const first = await session();
		const normalProcess = vault.process.getMockImplementation()!;
		vault.process.mockImplementation(async (file, update) => {
			const content = await normalProcess(file, update);
			if (file.path === (boundary === 'archive' ? inboxArchive : inbox)) {
				first.lifetime.abort();
				throw new DOMException('Simulated process termination', 'AbortError');
			}
			return content;
		});
		// Unloading stops the run instead of reporting the remaining notes as failed.
		await expect(first.archive([inbox])).rejects.toThrow('aborted');
		expect(records()).toHaveLength(1);
		vault.process.mockImplementation(normalProcess);
		const resumed = await session();
		expect(resumed.issues).toEqual([]);
		expect(records()).toEqual([]);
		expect(files.get(inbox)).toBe(`${open('a')}\n`);
		expect(files.get(inboxArchive)).toBe(`${done('b')}\n`);
	});

	it('leaves every reminder in its project when the archive write fails', async () => {
		const { files, vault, session, records } = await workspace({ [inbox]: `${open('a')}\n${done('b')}\n` });
		const { archive } = await session();
		const normalProcess = vault.process.getMockImplementation()!;
		vault.process.mockImplementation(async (file, update) => {
			if (file.path === inboxArchive) throw new Error('Disk full');
			return normalProcess(file, update);
		});
		await expect(archive([inbox])).resolves.toMatchObject({ archived: 0, failures: [{ path: inbox, error: 'Disk full' }] });
		expect(files.get(inbox)).toBe(`${open('a')}\n${done('b')}\n`);
		expect(records()).toEqual([]);
	});

	it('keeps a reminder edited during the run in its project without an archived copy', async () => {
		const { files, vault, session } = await workspace({ [inbox]: `${done('a')}\n${done('b')}\n` });
		const { archive } = await session();
		const normalProcess = vault.process.getMockImplementation()!;
		vault.process.mockImplementation(async (file, update) => {
			const content = await normalProcess(file, update);
			// Reopened on another device after the archive received it.
			if (file.path === inboxArchive && files.get(inbox)!.includes(done('b'))) files.set(inbox, `${done('a')}\n${open('b')}\n`);
			return content;
		});
		await expect(archive([inbox])).resolves.toMatchObject({ archived: 1, skipped: 1 });
		expect(files.get(inbox)).toBe(`${open('b')}\n`);
		expect(files.get(inboxArchive)).toBe(`${done('a')}\n`);
	});

	it('brings back the archived copy a run replaced when that reminder stays in its project', async () => {
		const { files, vault, session } = await workspace({
			[inbox]: `${done('b', 'Again')}\n`,
			[inboxArchive]: `${done('b', 'First time')}\n${done('old')}\n`,
		});
		const { archive } = await session();
		const normalProcess = vault.process.getMockImplementation()!;
		vault.process.mockImplementation(async (file, update) => {
			const content = await normalProcess(file, update);
			if (file.path === inboxArchive && files.get(inbox) === `${done('b', 'Again')}\n`) files.set(inbox, `${open('b')}\n`);
			return content;
		});
		await expect(archive([inbox])).resolves.toMatchObject({ archived: 0, skipped: 1 });
		expect(files.get(inbox)).toBe(`${open('b')}\n`);
		expect(files.get(inboxArchive)).toBe(`${done('old')}\n${done('b', 'First time')}\n`);
	});
});
