import { describe, expect, it } from 'vitest';
import {
	getProjectFromPath,
	scanReminderMarkdownContent,
} from './markdownScan';

describe('markdownScan', () => {
	it('derives projects from reminder file paths', () => {
		expect(getProjectFromPath('Reminders/Inbox.md', 'Reminders')).toBe('Inbox');
		expect(getProjectFromPath('Reminders/Personal/Health.md', 'Reminders')).toBe('Personal/Health');
		expect(getProjectFromPath('reminders/Work.md', 'Reminders')).toBe('reminders/Work');
	});

	it('scans checkbox reminders with descriptions and persisted ids', () => {
		const result = scanReminderMarkdownContent(
			'Reminders/Work.md',
			[
				'# Work',
				'',
				'- [ ] File taxes 2026-01-02 ! <!-- crate-id:r1 -->',
				'<!-- crate-desc:v1:collect%20receipts%0Aand%20confirm%20deductions -->',
				'- [x] Done task <!-- crate-id:r2 -->',
				'- [ ] missing id',
			].join('\n'),
			'Reminders',
		);

		expect(result.lineCount).toBe(6);
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
			lineNumber: 4,
		});
	});

	it('decodes comment-safe description blocks', () => {
		const result = scanReminderMarkdownContent(
			'Reminders/Work.md',
			[
				'- [ ] Encoded <!-- crate-id:r1 -->',
				'<!-- crate-desc:v1:line%20one%0Aline%20two%20%2D%2D%3E%20safe -->',
			].join('\n'),
			'Reminders',
		);

		expect(result.reminders).toHaveLength(1);
		expect(result.reminders[0]?.description).toBe('line one\nline two --> safe');
	});

	it.each(['\n', '\r\n'])('reads legacy descriptions literally and ignores tasks inside their comment: %j', newline => {
		const result = scanReminderMarkdownContent('Reminders/Work.md', [
			'- [ ] First <!-- crate-id:r1 -->',
			'<!-- crate-desc:100% complete %20 café 😀 -->',
			'- [ ] Second <!-- crate-id:r2 -->',
			'<!-- crate-desc:line one',
			'- [ ] description example',
			'line three -->',
			'- [ ] Third <!-- crate-id:r3 -->',
			'<!-- crate-desc:v1:current%20description -->',
		].join(newline), 'Reminders');
		expect(result.reminders.map(({ id, description }) => ({ id, description }))).toEqual([
			{ id: 'r1', description: '100% complete %20 café 😀' },
			{ id: 'r2', description: 'line one\n- [ ] description example\nline three' },
			{ id: 'r3', description: 'current description' },
		]);
	});

	it.each([
		'<!-- crate-desc:v2:unsupported -->',
		'<!-- crate-desc:v1:%invalid -->',
		'<!-- crate-desc:v1:unfinished',
		'<!-- crate-desc:unfinished',
		'<!-- crate-desc:details --> trailing text',
	])('does not turn unreadable metadata into an empty reminder list: %s', block => {
		expect(() => scanReminderMarkdownContent('Reminders/Work.md', `- [ ] Task <!-- crate-id:r1 -->\n${block}`, 'Reminders')).toThrow();
	});
});
