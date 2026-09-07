import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import {
  getReminderPage, mergeReorderedPage, ReminderPageSizeContext,
  ReminderPagination, useReminderPagination,
} from './reminder-pagination';

describe('reminder page bounds', () => {
  it('keeps the full list by default and handles empty lists', () => {
    expect(getReminderPage(10_000, 7, null)).toEqual({ start: 0, end: 10_000, total: 10_000, page: 0, pageCount: 1, pageSize: null });
    expect(getReminderPage(0, 4, 200)).toEqual({ start: 0, end: 0, total: 0, page: 0, pageCount: 1, pageSize: 200 });
  });

  it('includes every boundary row and clamps when the list shrinks', () => {
    expect(getReminderPage(401, 0, 200)).toMatchObject({ start: 0, end: 200, page: 0, pageCount: 3 });
    expect(getReminderPage(401, 1, 200)).toMatchObject({ start: 200, end: 400, page: 1 });
    expect(getReminderPage(401, 2, 200)).toMatchObject({ start: 400, end: 401, page: 2 });
    expect(getReminderPage(400, 2, 200)).toMatchObject({ start: 200, end: 400, page: 1, pageCount: 2 });
    expect(getReminderPage(10, 2, 200)).toMatchObject({ start: 0, end: 10, page: 0 });
    expect(getReminderPage(401, -1, 200).page).toBe(0);
  });

  it('normalizes invalid settings without empty or unbounded page counts', () => {
    for (const size of [0, -1, NaN, Infinity]) {
      expect(getReminderPage(10, 9, size)).toMatchObject({ start: 0, end: 10, page: 0, pageCount: 1, pageSize: null });
    }
    expect(getReminderPage(10, NaN, 2).page).toBe(0);
    expect(getReminderPage(Infinity, 0, 2).total).toBe(0);
    expect(getReminderPage(-5, 0, 2).total).toBe(0);
    expect(getReminderPage(5, 1.8, 2.8)).toMatchObject({ page: 1, start: 2, end: 4, pageSize: 2 });
  });
});

describe('reminder page controls', () => {
  it('keeps existing hosts unpaged and lets a host opt in', () => {
    function List() {
      const pagination = useReminderPagination(['first', 'second', 'third']);
      return React.createElement('div', null, pagination.items.join(', '),
        React.createElement(ReminderPagination, { pagination, label: 'Active reminders' }));
    }
    expect(renderToStaticMarkup(React.createElement(List))).toBe('<div>first, second, third</div>');
    const paged = renderToStaticMarkup(React.createElement(ReminderPageSizeContext.Provider, { value: 2 }, React.createElement(List)));
    expect(paged).toContain('first, second');
    expect(paged).not.toContain('third');
    expect(paged).toContain('1–2 of 3');
    expect(paged).toContain('aria-label="Active reminders page"');
  });

  it('omits controls for a single page and empty lists', () => {
    for (const total of [0, 200]) {
      expect(renderToStaticMarkup(React.createElement(ReminderPagination, {
        pagination: { ...getReminderPage(total, 0, 200), setPage: vi.fn() }, label: 'Completed reminders',
      }))).toBe('');
    }
  });

  it('labels native controls, formats ranges, and keeps boundary buttons focusable', () => {
    for (const page of [0, 49]) {
      const markup = renderToStaticMarkup(React.createElement(ReminderPagination, {
        pagination: { ...getReminderPage(10_000, page, 200), setPage: vi.fn() }, label: 'Completed reminders',
      }));
      expect(markup).toContain(page === 0 ? '1–200 of 10,000' : '9,801–10,000 of 10,000');
      expect(markup).toContain('<select aria-label="Completed reminders page"');
      expect(markup).toContain('aria-label="Previous completed reminders page"');
      expect(markup).toContain('aria-label="Next completed reminders page"');
      expect(markup).toContain('aria-disabled="true"');
      expect(markup).not.toContain(' disabled=');
      expect(markup).toContain('<option value="49"');
    }
  });

  it('disables page navigation during a drag', () => {
    const markup = renderToStaticMarkup(React.createElement(ReminderPagination, {
      pagination: { ...getReminderPage(1_000, 2, 200), setPage: vi.fn() }, label: 'Active reminders', disabled: true,
    }));
    expect(markup.match(/aria-disabled="true"/g)).toHaveLength(2);
    expect(markup).toContain('<select aria-label="Active reminders page" disabled=""');
  });
});

describe('merging a reordered reminder page', () => {
  const full = Array.from({ length: 7 }, (_, index) => ({ id: `${index}`, content: `Task ${index}` }));

  it.each([[0, 3], [2, 5], [5, 7]])('reorders only the captured range %i–%i', (start, end) => {
    const page = full.slice(start, end);
    const reversed = [...page].reverse();
    const merged = mergeReorderedPage(full, page, reversed);
    expect(merged).toEqual([...full.slice(0, start), ...reversed, ...full.slice(end)]);
    expect(full.map(item => item.id)).toEqual(['0', '1', '2', '3', '4', '5', '6']);
  });

  it('preserves the latest objects when content changes during a drag', () => {
    const page = full.slice(2, 5);
    const edited = full.map(item => ({ ...item, content: `${item.content} edited` }));
    const merged = mergeReorderedPage(edited, page, [...page].reverse());
    expect(merged?.map(item => item.id)).toEqual(['0', '1', '4', '3', '2', '5', '6']);
    for (const item of merged ?? []) expect(item).toBe(edited.find(current => current.id === item.id));
  });

  it('handles arbitrary reminder IDs as literal keys', () => {
    const items = ['__proto__', 'constructor', 'toString'].map(id => ({ id }));
    expect(mergeReorderedPage(items, items, [...items].reverse())).toEqual([...items].reverse());
  });

  it('rejects stale page order, non-contiguous pages, and removed rows', () => {
    const page = full.slice(2, 5);
    expect(mergeReorderedPage(full, [page[1]!, page[0]!, page[2]!], page)).toBeNull();
    expect(mergeReorderedPage(full, [full[1]!, full[3]!], [full[3]!, full[1]!])).toBeNull();
    expect(mergeReorderedPage(full.filter(item => item.id !== '3'), page, page)).toBeNull();
    expect(mergeReorderedPage(full, [{ id: 'absent', content: '' }], [{ id: 'absent', content: '' }])).toBeNull();
  });

  it('rejects missing, unexpected, and duplicate IDs without losing the full list', () => {
    const page = full.slice(2, 5);
    expect(mergeReorderedPage(full, page, page.slice(1))).toBeNull();
    expect(mergeReorderedPage(full, page, [page[0]!, page[0]!, page[2]!])).toBeNull();
    expect(mergeReorderedPage(full, page, [page[0]!, full[0]!, page[2]!])).toBeNull();
    expect(mergeReorderedPage([...full, full[0]!], page, page)).toBeNull();
    expect(mergeReorderedPage([full[0]!, full[0]!], [full[0]!, full[0]!], [full[0]!, full[0]!])).toBeNull();
    expect(mergeReorderedPage(full, [], [])).toBeNull();
  });
});
