import { act } from 'react';
import { expect, it } from 'vitest';
import { renderHook } from '../../test/react-hooks';
import type { ReadingItem } from '../core/model';
import { keepDeparted, useDepartedRows } from './useDepartedRows';

const note = (id: string) => ({ crate_reading_id: id, title: id, tags: [], reading_status: 'inbox', saved_at: '2026-01-01T00:00:00.000Z', source_url: `https://example.com/${id}` }) as ReadingItem;
const [a, b, c, d] = ['a', 'b', 'c', 'd'].map(note);
const ids = (rows: ReadingItem[]) => rows.map(row => row.crate_reading_id);

it('keeps departed rows after the row they followed', () => {
	expect(ids(keepDeparted([a, b, c, d], [b, d]))).toEqual(['a', 'b', 'c', 'd']);
	expect(ids(keepDeparted([a, b, c], [c, d]))).toEqual(['a', 'b', 'c', 'd']);
	const items = [a, b];
	expect(keepDeparted([a, b], items)).toBe(items);
});

it('lists departed rows until they settle, and drops them for a new scope', () => {
	let items = [a, b, c], scope = 'inbox';
	const hook = renderHook(() => useDepartedRows(items, scope));
	items = [a, c];
	hook.rerender();
	expect(ids(hook.current.rows)).toEqual(['a', 'b', 'c']);
	expect([...hook.current.departed]).toEqual(['b']);
	act(() => hook.current.settle(['b']));
	expect(ids(hook.current.rows)).toEqual(['a', 'c']);
	expect(hook.current.departed.size).toBe(0);
	items = [a];
	scope = 'archived';
	hook.rerender();
	expect(ids(hook.current.rows)).toEqual(['a']);
});

it('lists a row that returns before it settles as live again', () => {
	let items = [a, b];
	const hook = renderHook(() => useDepartedRows(items, 'inbox'));
	items = [a];
	hook.rerender();
	items = [a, b];
	hook.rerender();
	expect(ids(hook.current.rows)).toEqual(['a', 'b']);
	expect(hook.current.departed.size).toBe(0);
});
