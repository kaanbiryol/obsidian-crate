import React, { act } from 'react';
import { expect, it, vi } from 'vitest';
import { renderHook } from '@/test/react-hooks';
import type { Reminder } from '@/reminders/types/plugin-reminder';
import type CratePlugin from '@/main';

vi.mock('@/reminders/ui/plugin/ReminderCardWrapper', () => ({
  ReminderCardWrapper: ({ reminder }: { reminder: Reminder }) => React.createElement('div', { className: 'card', 'data-id': reminder.id }),
}));
vi.mock('@/reminders/ui/hooks/useObsidianDarkMode', () => ({ useObsidianDarkMode: () => false }));
vi.mock('@/ui/shared/useReducedMotion', () => ({ useReducedMotion: () => true }));
vi.mock('@/reminders/ui/hooks/useIndexRefresh', () => ({ useIndexRefresh: () => ({ refreshToken: 0, triggerRefresh: () => {} }) }));
vi.mock('@/reminders/settings', () => ({ useRemindersSettingsStore: (select: (state: { enabled: boolean }) => unknown) => select({ enabled: true }) }));
vi.mock('@/ui/obsidian-icon', () => ({ ObsidianIcon: () => null }));
vi.mock('./styles.scss', () => ({}));
vi.mock('@/reminders/components/ShadowDOMButton', () => ({ ShadowDOMButton: () => null }));

import { PluginContext } from '@/reminders/ui/reminders-context';
import { RemindersList } from './RemindersList';

function localDay(offset: number): string {
  const day = new Date(); day.setDate(day.getDate() + offset);
  return `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
}

const reminders: Reminder[] = Array.from({ length: 450 }, (_, i) => ({
  id: `r${i}`, content: `Task ${i}`, priority: 4, completed: false, project: 'Work', lineNumber: i,
  dueDate: localDay(1 + i % 3),
}));

function mount(props: React.ComponentProps<typeof RemindersList>) {
  const repository = { getActive: vi.fn(() => reminders), getAll: vi.fn(() => reminders), getTodayReminders: vi.fn(() => reminders) };
  const plugin = { reminderRepository: repository, reminderIndex: { isInitialLoadComplete: true }, remindersSettings: {} } as unknown as CratePlugin;
  renderHook(() => null, () => {
    for (const name of ['Node', 'Element', 'HTMLElement', 'HTMLButtonElement']) vi.stubGlobal(name, (window as unknown as Record<string, unknown>)[name]);
    Object.assign(window, { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout });
  }, () => React.createElement(PluginContext.Provider, { value: plugin }, React.createElement(RemindersList, props)));
  return repository;
}

const cards = () => Array.from(document.querySelectorAll('.card'));

it.each([
  ['a plain list', {}],
  ['a project list', { projectFilter: 'Work' }],
  ['an upcoming list', { showUpcoming: true }],
])('renders %s in pages of 200', async (_label, props) => {
  mount(props);
  await act(async () => {});
  expect(cards()).toHaveLength(200);
  expect(document.querySelector('.reminder-pagination')?.textContent).toContain('of 450');
});

it('groups only the visible upcoming page by date', async () => {
  mount({ showUpcoming: true });
  await act(async () => {});
  const grouped = Array.from(document.querySelectorAll('.reminders-date-group')).map(group => group.querySelectorAll('.card').length);
  expect(grouped.reduce((sum, count) => sum + count, 0)).toBe(200);
});

it.each([
  ['a plain list', {}, 'getActive', 0],
  ['a project list', { projectFilter: 'Work' }, 'getActive', 0],
  ['Today', { showToday: true }, 'getTodayReminders', 1],
  ['Upcoming', { showUpcoming: true }, 'getActive', 1],
] as const)('reloads %s on a clock change only when the query depends on time', async (_label, props, query, reloads) => {
  const repository = mount(props);
  await act(async () => {});
  const before = repository[query].mock.calls.length;
  // Resuming on the same day publishes no clock change, so nothing reloads.
  await act(async () => { window.dispatchEvent(new window.Event('focus')); });
  expect(repository[query].mock.calls.length - before).toBe(0);
  vi.useFakeTimers({ toFake: ['Date'] });
  try {
    vi.setSystemTime(Date.now() + 24 * 60 * 60_000);
    await act(async () => { window.dispatchEvent(new window.Event('focus')); });
  } finally {
    vi.useRealTimers();
  }
  expect(repository[query].mock.calls.length - before).toBe(reloads);
});
