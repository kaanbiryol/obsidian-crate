import { act } from 'react';
import { expect, it } from 'vitest';
import { renderHook } from '../../test/react-hooks';
import type { ReadingItem } from '../core/model';
import { keepDeparted, useDepartedRows } from './useDepartedRows';

const note = (id: string): ReadingItem => ({ crate_reading_version: 1, crate_reading_id: id, title: id, source_url: `https://example.com/${id}`, saved_at: '2026-01-01T00:00:00.000Z', reading_status: 'inbox', favorite: false, tags: [], extraction_status: 'ready', path: `Reading/${id}.md` });
const [a, b, c, d] = [note('a'), note('b'), note('c'), note('d')];
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

it('lets a saved link take over its pending copy in place', () => {
	const copy = { ...note('pending-op'), path: '', source_url: 'https://example.com/saved#intro', extraction_status: 'pending' as const };
	const saved = { ...note('server-id'), source_url: 'https://example.com/saved' };
	expect(ids(keepDeparted([copy, a, b], [saved, a, b]))).toEqual(['server-id', 'a', 'b']);
	// A removed note, even of the same link, still collapses.
	expect(ids(keepDeparted([{ ...a, source_url: saved.source_url }, b], [saved, b]))).toEqual(['a', 'server-id', 'b']);
	let items = [copy, a];
	const hook = renderHook(() => useDepartedRows(items, 'inbox'));
	expect(hook.current.rowKey('pending-op')).toBe('pending-op');
	items = [saved, a];
	hook.rerender();
	expect(ids(hook.current.rows)).toEqual(['server-id', 'a']);
	expect(hook.current.departed.size).toBe(0);
	expect([hook.current.rowKey('server-id'), hook.current.rowKey('a')]).toEqual(['pending-op', 'a']);
	// The row keeps its key through later refreshes.
	items = [{ ...saved, title: 'Saved' }, a];
	hook.rerender();
	expect(hook.current.rowKey('server-id')).toBe('pending-op');
});
