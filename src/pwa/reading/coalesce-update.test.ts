import { expect, it } from 'vitest';
import { coalesceReadingHighlights } from './coalesce-update';
import type { PendingReading } from './storage';
const first = [{ start: 0, end: 3, text: 'One' }];
const next = [...first, { start: 4, end: 7, text: 'Two' }];
const pending = (): PendingReading => ({ id: 'op', sessionId: 'session', action: 'update', intent: { id: 'article', changes: { highlights: first }, before: {} } });
it('coalesces offline highlights while keeping the original absent-field precondition', () => {
	const op = pending();
	expect(coalesceReadingHighlights(op, { changes: { highlights: next }, before: { highlights: first } })).toBe(true);
	expect(op.intent.changes).toEqual({ highlights: next });
	expect(JSON.stringify(op.intent.before)).toBe('{}');
});
it('preserves dispatched operations and rejects stale peer edits', () => {
	const op = { ...pending(), body: 'exact saved bytes' };
	expect(coalesceReadingHighlights(op, { changes: { highlights: next } })).toBe(false);
	expect(op.body).toBe('exact saved bytes');
	expect(() => coalesceReadingHighlights(pending(), { changes: { highlights: next }, before: {} })).toThrow('another tab');
});
