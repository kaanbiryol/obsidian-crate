import React, { act } from 'react';
import { expect, it } from 'vitest';
import { renderHook } from '@/test/react-hooks';
import { useReminderCardInteractions } from './useReminderCardInteractions';

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
	await act(async () => { card.checkbox!.click(); });
	expect(calls).toBe(1);
	await act(async () => { settle(); });
	expect(card.preview).toBe(false);
});

it('does not preview reopening a completed reminder', async () => {
	let settle = () => {};
	const card = renderCard(true, () => new Promise<void>(resolve => { settle = resolve; }));
	await act(async () => { card.checkbox!.click(); });
	expect(card.preview).toBe(false);
	await act(async () => { settle(); });
});
