import React, { act } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { renderHook } from '@/test/react-hooks';
import { COMPLETION_HOLD_MS, useReminderCardInteractions } from './useReminderCardInteractions';

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

function renderCard(completed: boolean, onToggleComplete: () => Promise<void>) {
	const state = { preview: false, checkbox: null as HTMLElement | null };
	function Card() {
		const { wrapperRef, completionPreview } = useReminderCardInteractions({ completed, onEdit: () => {}, onToggleComplete });
		state.preview = completionPreview;
		return React.createElement('div', { ref: wrapperRef },
			React.createElement('span', { role: 'checkbox', ref: (element: HTMLElement | null) => { state.checkbox = element; } }));
	}
	renderHook(() => null, undefined, () => React.createElement(Card));
	return state;
}

it('previews completion and ignores clicks until the toggle settles', async () => {
	let settle = () => {};
	let calls = 0;
	const card = renderCard(false, () => { calls++; return new Promise<void>(resolve => { settle = resolve; }); });
	await act(async () => { card.checkbox!.click(); });
	expect(card.preview).toBe(true);
	expect(calls).toBe(0);
	await act(async () => { card.checkbox!.click(); });
	await act(async () => { await vi.advanceTimersByTimeAsync(COMPLETION_HOLD_MS); });
	expect(calls).toBe(1);
	await act(async () => { settle(); });
	expect(card.preview).toBe(false);
});

it('reopens a completed reminder at once without a preview', async () => {
	let settle = () => {};
	let calls = 0;
	const card = renderCard(true, () => { calls++; return new Promise<void>(resolve => { settle = resolve; }); });
	await act(async () => { card.checkbox!.click(); });
	expect(card.preview).toBe(false);
	expect(calls).toBe(1);
	await act(async () => { settle(); });
});
