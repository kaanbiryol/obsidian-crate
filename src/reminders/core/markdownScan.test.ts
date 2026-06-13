import { describe, expect, it } from 'vitest';
import {
	getProjectFromPath,
	scanReminderMarkdownContent,
} from './markdownScan';

describe('markdownScan', () => {
	it('derives projects from reminder file paths', () => {
		expect(getProjectFromPath('Reminders/Inbox.md', 'Reminders')).toBe('Inbox');
		expect(getProjectFromPath('Reminders/Personal/Health.md', 'Reminders')).toBe('Personal/Health');
		expect(getProjectFromPath('reminders/Work.md', 'Reminders')).toBe('Work');
	});

	it('scans checkbox reminders with descriptions and persisted ids', () => {
		const result = scanReminderMarkdownContent(
			'Reminders/Work.md',
			[
				'# Work',
				'',
				'- [ ] File taxes 2026-01-02 ! <!-- crate-id:r1 -->',
				'<!-- crate-desc:collect receipts',
				'and confirm deductions -->',
				'- [x] Done task <!-- crate-id:r2 -->',
				'- [ ] missing id',
			].join('\n'),
			'Reminders',
		);

		expect(result.lineCount).toBe(7);
		expect(result.reminders).toHaveLength(2);
		expect(result.reminders[0]).toMatchObject({
			id: 'r1',
			content: 'File taxes',
			description: 'collect receipts\nand confirm deductions',
			dueDate: '2026-01-02',
			priority: 1,
			completed: false,
			project: 'Work',
			lineNumber: 2,
		});
		expect(result.reminders[1]).toMatchObject({
			id: 'r2',
			content: 'Done task',
			completed: true,
			project: 'Work',
			lineNumber: 5,
		});
	});
});
