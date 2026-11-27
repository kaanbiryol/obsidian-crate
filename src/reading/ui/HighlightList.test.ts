import { createElement, Fragment } from 'react';
import { expect, it, vi } from 'vitest';
import { renderHook } from '../../test/react-hooks';
import type { ReadingItem } from '../core/model';
import type { ReadingHighlight } from '../core/highlights';
import { HighlightList } from './HighlightList';

const rendered = vi.hoisted(() => ({ rows: 0 }));
vi.mock('./ReadingSourceIcon', () => ({ ReadingSourceIcon: () => { rendered.rows++; return null; } }));

const item: ReadingItem = { crate_reading_version: 1, crate_reading_id: '12345678-1234-4123-8123-123456789abc',
	title: 'Article', path: 'Reading/article.md', source_url: 'https://example.test/article',
	saved_at: '2026-10-01T12:00:00Z', reading_status: 'inbox', favorite: false, tags: [], extraction_status: 'ready' };
const first: ReadingHighlight = { id: 'one', start: 0, end: 5, text: 'First' };
const second: ReadingHighlight = { id: 'two', start: 6, end: 12, text: 'Second' };

it('re-renders only the rows whose highlight changed when the list renders again', () => {
	let highlights = [first, second];
	// Like the library, each render passes a new entry array and new handlers.
	const list = () => createElement(HighlightList<ReadingItem>, { entries: highlights.map(highlight => ({ item, highlight })), onView: () => {}, onOpenItem: () => {} });
	// Base UI buttons check their element's type against the DOM's classes.
	const dom = () => { for (const name of ['HTMLElement', 'Element', 'Node']) vi.stubGlobal(name, (window as unknown as Record<string, unknown>)[name]); };
	const hook = renderHook(() => null, dom, children => createElement(Fragment, null, children, list()));
	expect(rendered.rows).toBe(2);
	hook.rerender();
	expect(rendered.rows).toBe(2);
	highlights = [first, { ...second, note: 'Edited' }];
	hook.rerender();
	expect(rendered.rows).toBe(3);
});
