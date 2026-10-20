import { describe, expect, it } from 'vitest';
import { handleReorderReminders } from './routes/reorder';
import { createEnv } from '../test-support/reminders-web-test-harness';

describe('reminders web handlers', () => {
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
