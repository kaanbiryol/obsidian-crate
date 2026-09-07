import { createContext, useContext, useMemo, useState } from 'react';

/** Hosts opt in to bounded rendering; the Obsidian plugin retains its full lists. */
export const ReminderPageSizeContext = createContext<number | null>(null);

interface ReminderPage {
  start: number;
  end: number;
  total: number;
  page: number;
  pageCount: number;
  pageSize: number | null;
}

/** Page indexes and start are zero-based; end is exclusive. */
export function getReminderPage(total: number, page: number, pageSize: number | null): ReminderPage {
  total = Number.isFinite(total) ? Math.max(0, Math.floor(total)) : 0;
  pageSize = pageSize !== null && Number.isFinite(pageSize) && pageSize >= 1
    ? Math.floor(pageSize) : null;
  const pageCount = pageSize === null ? 1 : Math.max(1, Math.ceil(total / pageSize));
  page = Number.isFinite(page) ? Math.max(0, Math.min(Math.floor(page), pageCount - 1)) : 0;
  const start = pageSize === null ? 0 : page * pageSize;
  return { start, end: Math.min(total, start + (pageSize ?? total)), total, page, pageCount, pageSize };
}

export function useReminderPagination<T>(items: readonly T[], resetKey?: unknown) {
  const pageSize = useContext(ReminderPageSizeContext);
  const [position, setPosition] = useState({ key: resetKey, page: 0 });
  const sameScope = Object.is(position.key, resetKey);
  const bounds = getReminderPage(items.length, sameScope ? position.page : 0, pageSize);
  // Settle clamping immediately so later additions cannot resurrect an old page.
  if (!sameScope || position.page !== bounds.page) {
    setPosition({ key: resetKey, page: bounds.page });
  }
  const visibleItems = useMemo(() => items.slice(bounds.start, bounds.end), [items, bounds.start, bounds.end]);
  return { ...bounds, items: visibleItems, setPage: (page: number) => setPosition({ key: resetKey, page }) };
}

export function ReminderPagination({ pagination, label, disabled = false }: {
  pagination: ReminderPage & { setPage: (page: number) => void };
  label: string;
  disabled?: boolean;
}) {
  const { start, end, total, page, pageCount, setPage } = pagination;
  if (pageCount <= 1) return null;
  return (
    <nav aria-label={`${label} pages`} className="reminder-pagination">
      <span>{(start + 1).toLocaleString()}–{end.toLocaleString()} of {total.toLocaleString()}</span>
      <div className="reminder-pagination-controls">
        <button type="button" aria-label={`Previous ${label.toLowerCase()} page`} aria-disabled={disabled || page === 0}
          onClick={() => { if (!disabled && page > 0) setPage(page - 1); }}>Previous</button>
        <select aria-label={`${label} page`} value={page} disabled={disabled}
          onChange={event => { if (!disabled) setPage(Number(event.currentTarget.value)); }}>
          {Array.from({ length: pageCount }, (_, index) => <option key={index} value={index}>Page {index + 1}</option>)}
        </select>
        <button type="button" aria-label={`Next ${label.toLowerCase()} page`} aria-disabled={disabled || page === pageCount - 1}
          onClick={() => { if (!disabled && page < pageCount - 1) setPage(page + 1); }}>Next</button>
      </div>
    </nav>
  );
}

/** Reject stale drag payloads and retain current objects, including edits made during a drag. */
export function mergeReorderedPage<T extends { id: string }>(
  full: readonly T[], pageItems: readonly T[], reordered: readonly T[],
): T[] | null {
  if (!pageItems.length || reordered.length !== pageItems.length) return null;
  const start = full.findIndex(item => item.id === pageItems[0]?.id);
  if (start < 0 || pageItems.some((item, index) => full[start + index]?.id !== item.id)) return null;
  const current = new Map(full.map(item => [item.id, item]));
  const pageIds = new Set(pageItems.map(item => item.id));
  if (current.size !== full.length || pageIds.size !== pageItems.length) return null;
  const replacement: T[] = [];
  for (const item of reordered) {
    if (!pageIds.delete(item.id)) return null;
    const latest = current.get(item.id);
    if (!latest) return null;
    replacement.push(latest);
  }
  return [...full.slice(0, start), ...replacement, ...full.slice(start + pageItems.length)];
}
