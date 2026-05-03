import { describe, expect, it } from 'vitest';
import {
	appendReminderBlockToContent,
	deleteReminderBlockFromContent,
	findReminderLineNumber,
	replaceReminderBlockInContent,
	reorderReminderBlocksInContent,
	type ReminderLineRecord,
} from './markdownReminderFile';

function makeRecord(overrides: Partial<ReminderLineRecord>): ReminderLineRecord {
	return {
		id: overrides.id ?? 'r1',
		content: overrides.content ?? 'Task',
		dueDate: overrides.dueDate,
		dueDatetime: overrides.dueDatetime,
		priority: overrides.priority ?? 4,
		completed: overrides.completed ?? false,
		recurrence: overrides.recurrence,
		lineNumber: overrides.lineNumber ?? 0,
		rawLine: overrides.rawLine ?? '- [ ] Task <!-- crate-id:r1 -->',
	};
}

describe('markdownReminderFile', () => {
	it('appends reminder blocks after a project heading with optional descriptions', () => {
		const content = appendReminderBlockToContent(
			'# Work\n\n',
			'- [ ] Task <!-- crate-id:r1 -->',
			' extra details ',
		);

		expect(content).toBe([
			'# Work',
			'',
			'- [ ] Task <!-- crate-id:r1 -->',
			'<!-- crate-desc:extra details -->',
			'',
		].join('\n'));
	});

	it('replaces and deletes reminder blocks together with description lines', () => {
		const initial = [
			'# Work',
			'',
			'- [ ] Task Jan 1, 2026 <!-- crate-id:r1 -->',
			'<!-- crate-desc:old details -->',
			'- [ ] Keep Jan 2, 2026 <!-- crate-id:r2 -->',
			'',
		].join('\n');
		const reminder = makeRecord({
			id: 'r1',
			content: 'Task',
			dueDate: '2026-01-01',
			lineNumber: 2,
			rawLine: '- [ ] Task Jan 1, 2026 <!-- crate-id:r1 -->',
		});

		const replacement = replaceReminderBlockInContent(initial, reminder, [
			'- [ ] Updated Jan 3, 2026 <!-- crate-id:r1 -->',
			'<!-- crate-desc:new details -->',
		]);
		expect(replacement.found).toBe(true);
		expect(replacement.lineNumber).toBe(2);
		expect(replacement.content).toContain('Updated Jan 3, 2026');
		expect(replacement.content).toContain('crate-desc:new details');
		expect(replacement.content).not.toContain('old details');

		const deletion = deleteReminderBlockFromContent(replacement.content, {
			...reminder,
			content: 'Updated',
			dueDate: '2026-01-03',
			rawLine: '- [ ] Updated Jan 3, 2026 <!-- crate-id:r1 -->',
		});
		expect(deletion.found).toBe(true);
		expect(deletion.content).not.toContain('Updated Jan 3, 2026');
		expect(deletion.content).not.toContain('crate-desc:new details');
		expect(deletion.content).toContain('Keep Jan 2, 2026');
	});

	it('finds moved reminders by persisted ID and semantic fallback', () => {
		const lines = [
			'# Work',
			'',
			'- [ ] File taxes Jan 2, 2026',
			'- [ ] Renew passport <!-- crate-id:r2 -->',
		];

		expect(findReminderLineNumber(lines, makeRecord({
			id: 'r2',
			content: 'Renew passport',
			lineNumber: 0,
			rawLine: '- [ ] stale',
		}))).toBe(3);
		expect(findReminderLineNumber(lines, makeRecord({
			id: 'missing-id',
			content: 'File taxes',
			dueDate: '2026-01-02',
			lineNumber: 0,
			rawLine: '- [ ] stale',
		}))).toBe(2);
	});

	it('reorders active reminder blocks while preserving descriptions and completed blocks', () => {
		const initial = [
			'# Work',
			'',
			'- [ ] First Jan 1, 2026 <!-- crate-id:r1 -->',
			'<!-- crate-desc:first note -->',
			'- [ ] Second Jan 2, 2026 <!-- crate-id:r2 -->',
			'- [x] Done Jan 3, 2026 <!-- crate-id:r3 -->',
			'',
			'Footer',
			'',
		].join('\n');

		const lines = reorderReminderBlocksInContent(initial, ['r2', 'r1']).split('\n');
		const secondIndex = lines.findIndex((line) => line.includes('Second Jan 2, 2026'));
		const firstIndex = lines.findIndex((line) => line.includes('First Jan 1, 2026'));
		const descIndex = lines.findIndex((line) => line.includes('crate-desc:first note'));
		const doneIndex = lines.findIndex((line) => line.includes('Done Jan 3, 2026'));
		const footerIndex = lines.findIndex((line) => line === 'Footer');

		expect(secondIndex).toBeGreaterThan(0);
		expect(firstIndex).toBeGreaterThan(secondIndex);
		expect(descIndex).toBe(firstIndex + 1);
		expect(doneIndex).toBeGreaterThan(descIndex);
		expect(footerIndex).toBeGreaterThan(doneIndex);
	});
});
