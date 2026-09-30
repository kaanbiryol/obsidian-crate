import { describe, expect, it } from 'vitest';
import {
	appendReminderBlockToContent,
	buildDescriptionBlock,
	decodeDescriptionFromMarkdown,
	deleteReminderBlockFromContent,
	encodeDescriptionForMarkdown,
	findReminderLineNumber,
	replaceReminderBlockInContent,
	reorderReminderBlocksInContent,
	type ReminderLineRecord,
} from './markdownReminderFile';

function makeRecord(overrides: Partial<ReminderLineRecord>): ReminderLineRecord {
	return {
		id: overrides.id ?? 'r1',
		description: overrides.description,
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
			'<!-- crate-desc:v1:extra%20details -->',
			'',
		].join('\n'));
	});

	it('encodes description payloads so comment syntax and newlines round-trip safely', () => {
		const description = 'line one\nline two --> still text -- ok';
		const encoded = encodeDescriptionForMarkdown(description);

		expect(encoded).not.toContain('--');
		expect(encoded).not.toContain('\n');
		expect(encoded).not.toContain('>');
		expect(decodeDescriptionFromMarkdown(encoded)).toBe(description);
		expect(decodeDescriptionFromMarkdown(' legacy 100% %20 café 😀 ')).toBe('legacy 100% %20 café 😀');
		expect(() => decodeDescriptionFromMarkdown('v2:plain text')).toThrow('Unsupported reminder description encoding');
		expect(() => decodeDescriptionFromMarkdown('v1:%invalid')).toThrow();
	});

	it('edits and deletes multiline legacy descriptions without consuming the next reminder', () => {
		const rawLine = '- [ ] Task <!-- crate-id:r1 -->';
		const description = 'collect 100% of receipts\nand confirm %20 deductions';
		const next = '- [ ] Keep <!-- crate-id:r2 -->\n';
		const initial = `${rawLine}\n<!-- crate-desc:${description} -->\n${next}`;
		const reminder = makeRecord({ rawLine, description });
		const updated = replaceReminderBlockInContent(initial, reminder, [rawLine, ...buildDescriptionBlock(description)]);
		expect(updated.content).toBe(`${rawLine}\n<!-- crate-desc:v1:collect%20100%25%20of%20receipts%0Aand%20confirm%20%2520%20deductions -->\n${next}`);
		expect(deleteReminderBlockFromContent(initial, reminder).content).toBe(next);
		expect(() => replaceReminderBlockInContent(initial.replace('100%', '90%'), reminder, [rawLine]))
			.toThrow('Reminder changed while it was being edited');
	});

	it('reorders multiline legacy descriptions together with their task without rewriting metadata', () => {
		const first = '- [ ] First <!-- crate-id:r1 -->\n<!-- crate-desc:line one\nline two -->';
		const second = '- [ ] Second <!-- crate-id:r2 -->';
		expect(reorderReminderBlocksInContent(`${first}\n${second}\n`, ['r2', 'r1']))
			.toBe(`${second}\n${first}\n`);
	});

	it.each([
		'<!-- crate-desc:v2:unsupported -->',
		'<!-- crate-desc:v1:%invalid -->',
		'<!-- crate-desc:v1:line%20one\nline%20two -->',
		'<!-- crate-desc:unfinished',
		'<!-- crate-desc:details --> trailing text',
		'<!-- crate-desc:details --> extra -->',
		'<!-- crate-desc:details\n<!-- unrelated -->',
	])('rejects unsafe description edits and deletions: %s', block => {
		const reminder = makeRecord({ description: 'details' });
		const content = `${reminder.rawLine}\n${block}\n`;
		expect(() => replaceReminderBlockInContent(content, reminder, [reminder.rawLine])).toThrow();
		expect(() => deleteReminderBlockFromContent(content, reminder)).toThrow();
		expect(() => reorderReminderBlocksInContent(content, ['r1'])).toThrow();
	});

	it('replaces and deletes reminder blocks together with description lines', () => {
		const initial = [
			'# Work',
			'',
			'- [ ] Task Jan 1, 2026 <!-- crate-id:r1 -->',
			'<!-- crate-desc:v1:old%20details -->',
			'- [ ] Keep Jan 2, 2026 <!-- crate-id:r2 -->',
			'',
		].join('\n');
		const reminder = makeRecord({
			id: 'r1',
			content: 'Task',
			dueDate: '2026-01-01',
			description: 'old details',
			lineNumber: 2,
			rawLine: '- [ ] Task Jan 1, 2026 <!-- crate-id:r1 -->',
		});

		const replacement = replaceReminderBlockInContent(initial, reminder, [
			'- [ ] Updated Jan 3, 2026 <!-- crate-id:r1 -->',
			'<!-- crate-desc:v1:new%20details -->',
		]);
		expect(replacement.found).toBe(true);
		expect(replacement.lineNumber).toBe(2);
		expect(replacement.content).toContain('Updated Jan 3, 2026');
		expect(replacement.content).toContain('crate-desc:v1:new%20details');
		expect(replacement.content).not.toContain('old details');

		const deletion = deleteReminderBlockFromContent(replacement.content, {
			...reminder,
			content: 'Updated',
			description: 'new details',
			dueDate: '2026-01-03',
			rawLine: '- [ ] Updated Jan 3, 2026 <!-- crate-id:r1 -->',
		});
		expect(deletion.found).toBe(true);
		expect(deletion.content).not.toContain('Updated Jan 3, 2026');
		expect(deletion.content).not.toContain('crate-desc:v1:new%20details');
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
			'<!-- crate-desc:v1:first%20note -->',
			'- [ ] Second Jan 2, 2026 <!-- crate-id:r2 -->',
			'- [x] Done Jan 3, 2026 <!-- crate-id:r3 -->',
			'',
			'Footer',
			'',
		].join('\n');

		const lines = reorderReminderBlocksInContent(initial, ['r2', 'r1']).split('\n');
		const secondIndex = lines.findIndex((line) => line.includes('Second Jan 2, 2026'));
		const firstIndex = lines.findIndex((line) => line.includes('First Jan 1, 2026'));
		const descIndex = lines.findIndex((line) => line.includes('crate-desc:v1:first%20note'));
		const doneIndex = lines.findIndex((line) => line.includes('Done Jan 3, 2026'));
		const footerIndex = lines.findIndex((line) => line === 'Footer');

		expect(secondIndex).toBeGreaterThan(0);
		expect(firstIndex).toBeGreaterThan(secondIndex);
		expect(descIndex).toBe(firstIndex + 1);
		expect(doneIndex).toBeGreaterThan(descIndex);
		expect(footerIndex).toBeGreaterThan(doneIndex);
	});
});
