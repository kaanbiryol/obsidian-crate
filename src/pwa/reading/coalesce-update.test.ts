import { expect, it } from 'vitest';
import { assertReadingUpdateBase, coalesceReadingUpdate } from './coalesce-update';
import type { PendingReading } from './storage';
import { writeMarkdownHighlights } from '@/reading/core/markdown-highlights';
import { presentReadingItems } from './pending-view';
import type { ReadingItem } from '@/reading/core/model';
const first = [{ start: 0, end: 3, text: 'One' }];
const next = [...first, { start: 4, end: 7, text: 'Two' }];
const pending = (): PendingReading => ({ id: 'op', sessionId: 'session', action: 'update', intent: { id: 'article', changes: { highlights: first }, before: {} } });
it('coalesces offline highlights while keeping the original absent-field precondition', () => {
	const op = pending();
	expect(coalesceReadingUpdate(op, { changes: { highlights: next }, before: { highlights: first } })).toBe(true);
	expect(op.intent.changes).toEqual({ highlights: next });
	expect(JSON.stringify(op.intent.before)).toBe('{}');
});
it('preserves dispatched operations and rejects stale peer edits', () => {
	const op = { ...pending(), body: 'exact saved bytes' };
	expect(coalesceReadingUpdate(op, { changes: { highlights: next } })).toBe(false);
	expect(op.body).toBe('exact saved bytes');
	expect(() => coalesceReadingUpdate(pending(), { changes: { highlights: next }, before: {} })).toThrow('another tab');
});
it('combines repeated offline edits while retaining each original precondition', () => {
	const op: PendingReading = { id: 'op', sessionId: 'session', action: 'update',
		intent: { id: 'article', changes: { favorite: true }, before: { favorite: false } } };
	expect(coalesceReadingUpdate(op, { changes: { tags: ['essays'] }, before: { tags: [] } })).toBe(true);
	expect(coalesceReadingUpdate(op, { changes: { favorite: false, reading_status: 'archived' }, before: { favorite: true, reading_status: 'inbox' } })).toBe(true);
	expect(op.intent).toEqual({ id: 'article', changes: { favorite: false, tags: ['essays'], reading_status: 'archived' },
		before: { favorite: false, tags: [], reading_status: 'inbox' } });
});
it('checks follow-up edits against the last pending value, including dispatched changes', () => {
	const operations: PendingReading[] = [
		{ id: 'first', sessionId: 'session', action: 'update', body: 'immutable', intent: { changes: { favorite: true, tags: ['essays'] } } },
		{ id: 'second', sessionId: 'session', action: 'update', intent: { changes: { favorite: false } } },
	];
	expect(() => assertReadingUpdateBase(operations, { changes: { favorite: true, tags: [] }, before: { favorite: false, tags: ['essays'] } })).not.toThrow();
	expect(() => assertReadingUpdateBase(operations, { changes: { favorite: false }, before: { favorite: true } })).toThrow('another tab');
});
it('coalesces annotated Markdown highlights after optimistic normalization', () => {
	const highlights = writeMarkdownHighlights('One Two', first).highlights;
	const op = pending(); op.intent.changes = { highlights };
	const item = { crate_reading_id: 'article' } as ReadingItem;
	const visible = presentReadingItems([item], [op])[0]!;
	expect(visible.highlight_format).toBe('markdown-v1');
	expect(coalesceReadingUpdate(op, { changes: { highlights: [] }, before: { highlights: visible.highlights } })).toBe(true);
});
it('preserves code anchors through optimistic display and offline resizing', () => {
	const highlights = writeMarkdownHighlights('`DSButton`', [{ start: 2, end: 8, text: 'Button' }]).highlights;
	const op = pending(); op.intent.changes = { highlights };
	const visible = presentReadingItems([{ crate_reading_id: 'article' } as ReadingItem], [op])[0]!;
	expect(visible.highlights?.[0]?.codeAnchor).toBe(true);
	const resized = writeMarkdownHighlights('`DSButton`', [{ start: 0, end: 8, text: 'DSButton', codeAnchor: true }]).highlights;
	expect(coalesceReadingUpdate(op, { changes: { highlights: resized }, before: { highlights: visible.highlights } })).toBe(true);
	expect(op.intent.changes).toEqual({ highlights: resized });
	expect(resized[0]?.codeAnchor).toBeUndefined();
});
it('preserves text anchors through optimistic display, annotation and offline coalescing', () => {
	const highlights = writeMarkdownHighlights('<div>One Two</div>', first).highlights;
	const op = pending(); op.intent.changes = { highlights };
	const visible = presentReadingItems([{ crate_reading_id: 'article' } as ReadingItem], [op])[0]!;
	expect(visible.highlights?.[0]?.textAnchor).toBe(true);
	const annotated = writeMarkdownHighlights('<div>One Two</div>', [{ ...visible.highlights![0]!, note: 'Keep it' }]).highlights;
	expect(coalesceReadingUpdate(op, { changes: { highlights: annotated }, before: { highlights: visible.highlights } })).toBe(true);
	expect(op.intent.changes).toEqual({ highlights: annotated });
	expect(annotated[0]).toMatchObject({ textAnchor: true, note: 'Keep it' });
});
