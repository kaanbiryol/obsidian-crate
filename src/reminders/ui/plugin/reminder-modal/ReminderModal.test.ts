import React from 'react';
import { beforeEach, expect, it, vi } from 'vitest';
import { renderHook } from '@/test/react-hooks';
import type CratePlugin from '@/plugin/CratePlugin';
import type { Reminder } from '@/reminders/types/reminder';

const { notices, editor } = vi.hoisted(() => ({
	notices: [] as string[],
	editor: { current: undefined as undefined | { onSave: (reminder: Reminder) => Promise<void>; onDelete: (reminder: Reminder) => Promise<void> } },
}));
vi.mock('obsidian', () => ({ Notice: class { constructor(message: string) { notices.push(message); } } }));
vi.mock('./AddReminderModal', () => ({ AddReminderModal: (props: NonNullable<typeof editor.current>) => { editor.current = props; return null; } }));
vi.mock('@/ui/plugin/hooks/useObsidianKeyboardHeight', () => ({ useObsidianKeyboardHeight: () => 0 }));

import { ModalContext, PluginContext } from '@/reminders/ui/plugin/reminders-context';
import { ReminderModal } from './ReminderModal';

const reminder: Reminder = { id: 'r1', content: 'Call Ada', priority: 4, completed: false, project: 'Inbox', lineNumber: 0 };
const sourceIssue = 'Refresh reminders before editing Reminders/Inbox.md. Save this note as UTF-8.';

function mount(repository: Record<string, unknown>) {
	const plugin = { reminders: { repository: { getProjects: () => [], ...repository } } } as unknown as CratePlugin;
	renderHook(() => null, undefined, children => React.createElement(PluginContext.Provider, { value: plugin },
		React.createElement(ModalContext.Provider, { value: { close: () => {}, isMobile: false } }, React.createElement(ReminderModal, { reminder }), children)));
	return editor.current!;
}

beforeEach(() => { notices.length = 0; editor.current = undefined; });

it('shows why an edit failed', async () => {
	const props = mount({ update: vi.fn(async () => { throw new Error(sourceIssue); }) });
	await expect(props.onSave(reminder)).rejects.toThrow(sourceIssue);
	expect(notices).toEqual([sourceIssue]);
});

it('shows why a delete failed', async () => {
	const props = mount({ delete: vi.fn(async () => { throw new Error(sourceIssue); }) });
	await expect(props.onDelete(reminder)).rejects.toThrow(sourceIssue);
	expect(notices).toEqual([sourceIssue]);
});

it('reports a missing reminder once', async () => {
	const props = mount({ update: vi.fn(async () => null), delete: vi.fn(async () => false) });
	await expect(props.onSave(reminder)).rejects.toThrow();
	await expect(props.onDelete(reminder)).rejects.toThrow();
	expect(notices).toEqual(['Reminder no longer exists. Refresh to continue.', 'Reminder no longer exists. Refresh to continue.']);
});
