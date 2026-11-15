import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { EditorState } from '@codemirror/state';
import { createReminderMarkerHiding } from './reminder-marker-hiding';
import { readDescriptionBlock } from '../core/reminderDescription';

const extensions = createReminderMarkerHiding(() => true, () => false);
const reminder = '- [ ] Buy milk 2026-12-01 <!-- crate-id:a -->';
const descriptions = fc.constantFrom('Oat milk', 'Oat milk\nfrom the shop', 'a\n\nb', '50% off', 'see [[Shop]]');

/** Every description comment in `doc`: its text, or null when it no longer reads. */
function blocks(doc: string): (string | null)[] {
	const lines = doc.split('\n');
	return lines.flatMap((line, index) => {
		if (!line.startsWith('<!-- crate-desc:')) return [];
		try { return [readDescriptionBlock(lines, index - 1).description ?? '']; } catch { return [null]; }
	});
}

describe('editing inside a stored description', () => {
	it('never leaves a description comment that no longer reads', () => {
		fc.assert(fc.property(
			descriptions,
			fc.array(fc.record({
				kind: fc.constantFrom('insert', 'delete'),
				at: fc.nat(),
				length: fc.integer({ min: 1, max: 6 }),
				text: fc.constantFrom('x', ' ', '\n', '-', '--', '-->', '<!--', '<', '>', '!', 'crate-id:z', ' -->', '%', '\r'),
			}), { minLength: 1, maxLength: 25 }),
			(description, edits) => {
				let state = EditorState.create({ doc: `${reminder}\n<!-- crate-desc:${description} -->\nNext`, extensions });
				for (const { kind, at, length, text } of edits) {
					// Only edits inside the comment, from its first character to its last.
					const start = state.doc.toString().indexOf('<!-- crate-desc:'), end = state.doc.toString().indexOf(' -->', start) + 4;
					if (start === -1 || end < 4) return;
					const from = start + (at % (end - start));
					const change = kind === 'insert'
						? { from, insert: text }
						: { from, to: Math.min(end, from + length) };
					state = state.update({ changes: change, userEvent: kind === 'insert' ? 'input.type' : 'delete.backward' }).state;
					expect(blocks(state.doc.toString())).not.toContain(null);
					expect(state.doc.line(1).text).toBe(reminder);
				}
			},
		), { numRuns: 1500 });
	});

	it('keeps any cursor placed in a description between its comment markers', () => {
		fc.assert(fc.property(descriptions, fc.nat(), (description, at) => {
			const doc = `${reminder}\n<!-- crate-desc:${description} -->\nNext`;
			const start = doc.indexOf('<!-- crate-desc:'), end = doc.indexOf(' -->', start) + 4;
			const anchor = start + (at % (end - start + 1));
			const state = EditorState.create({ doc, extensions }).update({ selection: { anchor }, userEvent: 'select.pointer' }).state;
			const head = state.selection.main.head;
			expect(head).toBeGreaterThanOrEqual(start + '<!-- crate-desc:'.length);
			expect(head).toBeLessThanOrEqual(end - ' -->'.length);
		}), { numRuns: 500 });
	});
});
