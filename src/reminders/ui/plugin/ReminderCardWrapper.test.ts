import React, { act } from 'react';
import { expect, it, vi } from 'vitest';
import { renderHook } from '@/test/react-hooks';
import type CratePlugin from '@/plugin/CratePlugin';
import type { Reminder } from '@/reminders/types/reminder';

const { notices, card } = vi.hoisted(() => ({ notices: [] as string[], card: { toggle: undefined as undefined | (() => Promise<void>), props: undefined as undefined | Record<string, unknown> } }));
vi.mock('obsidian', () => ({ Notice: class { constructor(message: string) { notices.push(message); } } }));
vi.mock('@/reminders/ui/shared/ReminderCard', () => ({ ReminderCard: (props: Record<string, unknown>) => { card.props = props; return null; } }));
vi.mock('@/reminders/ui/shared/useReminderCardInteractions', () => ({
	useReminderCardInteractions: ({ onToggleComplete }: { onToggleComplete: () => Promise<void> }) => { card.toggle = onToggleComplete; return { wrapperRef: { current: null }, completionPreview: true }; },
}));
vi.mock('@/reminders/ui/plugin/reminder-modal/reminderEditorModals', () => ({ openReminderEditModal: vi.fn() }));

import { PluginContext } from '@/ui/plugin/plugin-context';
import { ReminderCardWrapper } from './ReminderCardWrapper';

it('shows why completing a reminder failed', async () => {
	const issue = 'Refresh reminders before editing Reminders/Inbox.md. Save this note as UTF-8.';
	const reminder: Reminder = { id: 'r1', content: 'Call Ada', priority: 4, completed: false, project: 'Inbox', lineNumber: 0 };
	const plugin = { reminders: { repository: { complete: vi.fn(async () => { throw new Error(issue); }) } } } as unknown as CratePlugin;
	renderHook(() => null, undefined, children => React.createElement(PluginContext.Provider, { value: plugin },
		React.createElement(ReminderCardWrapper, { reminder, colorScheme: 'light' }), children));
	await act(async () => { await card.toggle!(); });
	expect(notices).toEqual([issue]);
});

it('passes the reminder through with the shared completion preview', () => {
	const reminder: Reminder = { id: 'r1', content: 'Call Ada', priority: 4, completed: false, project: 'Inbox', lineNumber: 3 };
	renderHook(() => null, undefined, children => React.createElement(PluginContext.Provider, { value: {} as CratePlugin },
		React.createElement(ReminderCardWrapper, { reminder, colorScheme: 'light' }), children));
	expect(card.props?.reminder).toBe(reminder);
	expect(card.props?.completionPreview).toBe(true);
});
