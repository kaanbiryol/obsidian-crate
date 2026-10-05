import { describe, expect, it } from 'vitest';
import {
	buildDescriptionBlock,
	decodeDescriptionFromMarkdown,
	encodeDescriptionForMarkdown,
	readDescriptionBlock,
	ReminderDescriptionError,
} from './reminderDescription';

describe('reminder descriptions', () => {
	it.each(['kaan', 'hello world', 'hello%20world', '100% complete %invalid café 😀', 'line one\n- [ ] example\nline three', 'text\twith\ttabs'])(
		'writes descriptions as literal Markdown text: %j', description => {
			const block = buildDescriptionBlock(description);
			expect(block.join('\n')).toBe(`<!-- crate-desc:${description} -->`);
			expect(readDescriptionBlock(['- [ ] Task', ...block, '- [ ] Next'], 0)).toEqual({ description, lineCount: block.length });
		},
	);

	it.each(['text --> still text', '<!-- nested comment', 'text -- comment syntax', 'v1:hello%20world', 'v2:plain text', 'line one\r\nline two'])(
		'preserves text that cannot be written as a literal description comment: %j', description => {
			const block = buildDescriptionBlock(description);
			expect(block).toHaveLength(1);
			expect(block[0]).toMatch(/^<!-- crate-desc:v1:/);
			expect(readDescriptionBlock(['- [ ] Task', ...block], 0).description).toBe(description);
		},
	);

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

	it.each([
		['<!-- crate-desc:v2:unsupported -->', 'unsupported-description-encoding', 'Unsupported reminder description encoding'],
		['<!-- crate-desc:v1:%invalid -->', 'invalid-description-encoding', 'Invalid reminder description encoding'],
		['<!-- crate-desc:unfinished', 'invalid-description-block', 'Invalid reminder description block'],
		['<!-- crate-desc:details --> trailing text', 'invalid-description-block', 'Invalid reminder description block'],
		['<!-- crate-desc:details\n<!-- nested -->', 'invalid-description-block', 'Invalid reminder description block'],
	] as const)('retains the error category and first description line for %s', (block, code, message) => {
		const lines = ['# Project', '', '- [ ] Task', ...block.split('\n')];
		expect(() => readDescriptionBlock(lines, 2)).toThrow(new ReminderDescriptionError(code, 4));
		try {
			readDescriptionBlock(lines, 2);
		} catch (error) {
			expect(error).toBeInstanceOf(ReminderDescriptionError);
			expect(error).toMatchObject({ code, line: 4, message: `${message} on line 4` });
		}
	});
});
