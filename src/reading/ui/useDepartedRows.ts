import { useCallback, useMemo, useState } from 'react';
import { readingUrlIdentity, type ReadingItem } from '../core/model';

/** The listed `items` plus rows that left them while `scope` stayed the same, each in its
 * previous place, so the list can collapse them instead of dropping them. `settle` removes
 * departed rows once they have collapsed; a new scope lists `items` alone. A saved link that
 * replaces its pending copy takes that row over: `rowKey` gives it the copy's key, so the row
 * stays in place rather than one leaving as another arrives. */
export function useDepartedRows(items: ReadingItem[], scope: string) {
	const [state, setState] = useState({ scope, items, rows: items, keys: new Map<string, string>() });
	let { rows, keys } = state;
	if (state.items !== items || state.scope !== scope) {
		const same = state.scope === scope;
		keys = same ? replacedKeys(state.rows, items, state.keys) : new Map<string, string>();
		rows = same ? keepDeparted(state.rows, items) : items;
		setState({ scope, items, rows, keys });
	}
	const departed = useMemo(() => {
		if (rows === items) return new Set<string>();
		const live = new Set(items.map(item => item.crate_reading_id));
		return new Set(rows.filter(row => !live.has(row.crate_reading_id)).map(row => row.crate_reading_id));
	}, [rows, items]);
	const settle = useCallback((ids: readonly string[]) => setState(state => {
		const next = state.rows.filter(row => !ids.includes(row.crate_reading_id));
		return next.length === state.rows.length ? state : { ...state, rows: next };
	}), []);
	const rowKey = useCallback((id: string) => keys.get(id) ?? id, [keys]);
	return { rows, departed, settle, rowKey };
}

/** `items` in their order, with each row of `previous` they no longer hold after the row it
 * followed. A pending copy whose link `items` now lists has been replaced, not removed. */
export function keepDeparted(previous: ReadingItem[], items: ReadingItem[]): ReadingItem[] {
	const live = new Set(items.map(item => item.crate_reading_id));
	if (previous.every(row => live.has(row.crate_reading_id))) return items;
	const replaced = new Set(replacements(previous, items).keys());
	const after = new Map<string | null, ReadingItem[]>();
	let anchor: string | null = null;
	for (const row of previous) {
		if (live.has(row.crate_reading_id)) { anchor = row.crate_reading_id; continue; }
		if (replaced.has(row.crate_reading_id)) continue;
		const kept = after.get(anchor) ?? []; kept.push(row); after.set(anchor, kept);
	}
	const rows = [...after.get(null) ?? []];
	for (const item of items) rows.push(item, ...after.get(item.crate_reading_id) ?? []);
	return rows;
}

/** Each pending copy in `previous` (it has no note yet) that left `items`, by id, with the
 * new item that now lists its link. */
function replacements(previous: ReadingItem[], items: ReadingItem[]): Map<string, ReadingItem> {
	const live = new Set(items.map(item => item.crate_reading_id));
	const listed = new Set(previous.map(row => row.crate_reading_id));
	const pending = new Map<string, string>();
	for (const row of previous) {
		const url = !row.path && !live.has(row.crate_reading_id) && urlIdentity(row.source_url);
		if (url) pending.set(url, row.crate_reading_id);
	}
	const replaced = new Map<string, ReadingItem>();
	if (!pending.size) return replaced;
	for (const item of items) {
		if (listed.has(item.crate_reading_id)) continue;
		const id = pending.get(urlIdentity(item.source_url) || '');
		if (id && !replaced.has(id)) replaced.set(id, item);
	}
	return replaced;
}

/** The keys of rows still listed, with each replacement keyed as the copy it replaced. A copy
 * listed again takes its key back, so no two rows share one. */
function replacedKeys(previous: ReadingItem[], items: ReadingItem[], keys: ReadonlyMap<string, string>): Map<string, string> {
	const next = new Map<string, string>();
	for (const item of items) {
		const key = keys.get(item.crate_reading_id);
		if (key) next.set(item.crate_reading_id, key);
	}
	for (const [id, item] of replacements(previous, items)) next.set(item.crate_reading_id, keys.get(id) ?? id);
	const live = new Set(items.map(item => item.crate_reading_id));
	for (const [id, key] of next) if (live.has(key)) next.delete(id);
	return next;
}

function urlIdentity(url: string | undefined): string | null {
	if (!url) return null;
	try { return readingUrlIdentity(url); } catch { return null; }
}
