import { useCallback, useMemo, useState } from 'react';
import type { ReadingItem } from '../core/model';

/** The listed `items` plus rows that left them while `scope` stayed the same, each in its
 * previous place, so the list can collapse them instead of dropping them. `settle` removes
 * departed rows once they have collapsed; a new scope lists `items` alone. */
export function useDepartedRows(items: ReadingItem[], scope: string) {
	const [state, setState] = useState({ scope, items, rows: items });
	let { rows } = state;
	if (state.items !== items || state.scope !== scope) {
		rows = state.scope === scope ? keepDeparted(state.rows, items) : items;
		setState({ scope, items, rows });
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
	return { rows, departed, settle };
}

/** `items` in their order, with each row of `previous` they no longer hold after the row it followed. */
export function keepDeparted(previous: ReadingItem[], items: ReadingItem[]): ReadingItem[] {
	const live = new Set(items.map(item => item.crate_reading_id));
	if (previous.every(row => live.has(row.crate_reading_id))) return items;
	const after = new Map<string | null, ReadingItem[]>();
	let anchor: string | null = null;
	for (const row of previous) {
		if (live.has(row.crate_reading_id)) { anchor = row.crate_reading_id; continue; }
		const kept = after.get(anchor) ?? []; kept.push(row); after.set(anchor, kept);
	}
	const rows = [...after.get(null) ?? []];
	for (const item of items) rows.push(item, ...after.get(item.crate_reading_id) ?? []);
	return rows;
}
