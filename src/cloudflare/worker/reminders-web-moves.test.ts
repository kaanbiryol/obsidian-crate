import { describe, expect, it } from 'vitest';
import { handleReorderReminders } from './reminders-web/routes/reorder';
import { handleUpdateReminder } from './reminders-web/routes/update';
import { createEnv } from './reminders-web-test-harness';

describe('reminders web handlers', () => {
it('moves completed reminders by committing both files atomically', async () => {
		const workspace = await createEnv({
			bucketEntries: {
				'files/Reminders/Inbox.md': '# Inbox\n\n- [x] Done task Jan 1, 2026 <!-- crate-id:r-done -->\n',
			},
			files: {
				'Reminders/Inbox.md': null,
			},
		});

		const response = await handleUpdateReminder(
			new Request('https://worker.test/reminders/update', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: await workspace.mutationBody({
					folderPath: 'Reminders',
					id: 'r-done',
					filePath: 'Reminders/Inbox.md',
					project: 'Personal',
				}),
			}),
			workspace.env as never,
		);

		expect(response.status).toBe(200);
		expect(workspace.committedPaths).toEqual([
			'Reminders/Personal.md',
			'Reminders/Inbox.md',
		]);
		expect(workspace.readCurrentFile('Reminders/Inbox.md')).not.toContain('Done task');
		expect(workspace.readCurrentFile('Reminders/Personal.md')).toContain('- [x] Done task Jan 1, 2026 <!-- crate-id:r-done -->');
	});

	it('leaves both files unchanged when the source CAS fails during a move', async () => {
		const workspace = await createEnv({
			bucketEntries: {
				'files/Reminders/Inbox.md': '# Inbox\n\n- [ ] Keep task Jan 1, 2026 <!-- crate-id:r-keep -->\n',
			},
			files: { 'Reminders/Inbox.md': null },
			atomicSourceConflictPath: 'Reminders/Inbox.md',
		});

		await expect(handleUpdateReminder(
			new Request('https://worker.test/reminders/update', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: await workspace.mutationBody({
					folderPath: 'Reminders',
					id: 'r-keep',
					filePath: 'Reminders/Inbox.md',
					project: 'Personal',
				}),
			}),
			workspace.env as never,
		)).rejects.toMatchObject({ path: 'Reminders/Inbox.md' });

		expect(workspace.committedPaths).toEqual([]);
		expect(workspace.readCurrentFile('Reminders/Inbox.md')).toContain('Keep task');
		expect(workspace.readCurrentFile('Reminders/Personal.md')).toBeNull();
	});

	it('keeps the source reminder when the destination move write fails', async () => {
		const workspace = await createEnv({
			bucketEntries: {
				'files/Reminders/Inbox.md': '# Inbox\n\n- [ ] Keep task Jan 1, 2026 <!-- crate-id:r-keep -->\n',
			},
			files: {
				'Reminders/Inbox.md': null,
			},
			failPutWhen: (_key, content) => content.includes('# Personal') && content.includes('Keep task'),
		});

		await expect(handleUpdateReminder(
			new Request('https://worker.test/reminders/update', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: await workspace.mutationBody({
					folderPath: 'Reminders',
					id: 'r-keep',
					filePath: 'Reminders/Inbox.md',
					project: 'Personal',
				}),
			}),
			workspace.env as never,
		)).rejects.toThrow('forced put failure');

		expect(workspace.committedPaths).toEqual([]);
		expect(workspace.readCurrentFile('Reminders/Inbox.md')).toContain('Keep task');
		expect(workspace.readCurrentFile('Reminders/Personal.md')).toBeNull();
	});

	it('reorders active reminders while leaving completed reminders at the bottom', async () => {
		const workspace = await createEnv({
			bucketEntries: {
				'files/Reminders/Inbox.md': '# Inbox\n\n- [ ] First <!-- crate-id:r1 -->\n- [ ] Second <!-- crate-id:r2 -->\n- [x] Done <!-- crate-id:r3 -->\n',
			},
			files: {
				'Reminders/Inbox.md': null,
			},
		});

		const response = await handleReorderReminders(
			new Request('https://worker.test/reminders/reorder', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: await workspace.mutationBody({
					folderPath: 'Reminders',
					project: 'Inbox',
					orderedIds: ['r2', 'r1'],
				}),
			}),
			workspace.env as never,
		);

		expect(response.status).toBe(200);
		expect(workspace.readCurrentFile('Reminders/Inbox.md')).toContain('- [ ] Second <!-- crate-id:r2 -->\n- [ ] First <!-- crate-id:r1 -->\n- [x] Done <!-- crate-id:r3 -->');
	});
});
