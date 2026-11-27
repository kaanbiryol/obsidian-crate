import type { ReactNode } from 'react';
import { expect, it, vi } from 'vitest';
import { renderHook } from '../../../test/react-hooks';
import type { Reminder } from '../../core/model';
import { useRemindersShellModel } from './useRemindersShellModel';

it('renders cards without their list position, so removing a reminder above leaves them unchanged', () => {
	const reminder: Reminder = { id: 'b', content: 'Below', completed: false, priority: 4 };
	const renderCard = vi.fn(() => null);
	const hook = renderHook(() => useRemindersShellModel({ reminders: [reminder], projects: [], upcomingDays: 7, viewMode: 'inbox',
		selectedProject: null, renderCard, onAdd: () => {}, onReorder: () => {} }));
	// Lists call renderers with the row's position; the reminder moves up a row when the one above it is completed.
	const renderers: Array<(reminder: Reminder, index: number) => ReactNode> = [hook.current.listCardRenderer, hook.current.panelCardRenderer];
	for (const render of renderers) for (const index of [1, 0]) void render(reminder, index);
	expect(renderCard.mock.calls[0]).toEqual(renderCard.mock.calls[1]);
	expect(renderCard.mock.calls[2]).toEqual(renderCard.mock.calls[3]);
	expect(renderCard.mock.calls[0]).toEqual([{ reminder, hideProject: true }]);
});
