import type { ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Reminder } from '../types/reminder';
import { ReorderableReminderList } from './ReorderableReminderList';

// Retain refs between component renders and keep an earlier animation callback.
// The animation driver can finish a drag before React renders the new order.
const hooks = vi.hoisted(() => ({ refs: [] as Array<{ current: unknown }>, index: 0 }));
vi.mock('react', async importOriginal => ({
  ...await importOriginal<typeof import('react')>(),
  useRef: (current: unknown) => {
    const index = hooks.index++;
    return hooks.refs[index] ??= { current };
  },
  useState: (current: unknown) => [current, vi.fn()],
  useCallback: (callback: unknown) => callback,
}));
vi.mock('../ui/useObsidianReducedMotion', () => ({ useObsidianReducedMotion: () => false }));
vi.mock('../ui/reminder-pagination', async importOriginal => ({
  ...await importOriginal<typeof import('../ui/reminder-pagination')>(),
  useReminderPagination: (items: Reminder[]) => ({ items: items.slice(0, 2), start: 0 }),
}));

const reminder = (id: string, content = id): Reminder => ({ id, content, completed: false, priority: 4 });

type Row = ReactElement<{ onDragStart: () => void; onDragEnd: () => void }>;
type Group = ReactElement<{
  values: Reminder[];
  onReorder: (reordered: Reminder[]) => void;
  children: ReactElement<{ children: Row[] }>;
}>;

function harness(initial: Reminder[]) {
  const onReorder = vi.fn<(reminders: Reminder[]) => void>();
  const onReorderCommit = vi.fn();
  const onDragActiveChange = vi.fn();
  const render = (reminders: Reminder[]) => {
    hooks.index = 0;
    const result = ReorderableReminderList({ reminders, onReorder, onReorderCommit, onDragActiveChange, renderCard: () => null });
    return (result.props as { children: [unknown, Group] }).children[1];
  };
  return { render, group: render(initial), onReorder, onReorderCommit, onDragActiveChange };
}

beforeEach(() => { hooks.refs = []; hooks.index = 0; });

describe('reorder animation callbacks', () => {
  it('uses fresh reminder data when a retained callback runs after an edit', () => {
    const initial = ['a', 'b', 'c'].map(id => reminder(id));
    const { group, render, onReorder } = harness(initial);
    const edited = initial.map(item => reminder(item.id, `${item.content} edited`));
    render(edited);
    group.props.onReorder([...group.props.values].reverse());
    expect(onReorder).toHaveBeenCalledWith([edited[1], edited[0], edited[2]]);
    expect(onReorder.mock.calls[0]?.[0][0]).toBe(edited[1]);
  });

  it('rejects a retained page callback after a reminder was deleted', () => {
    const initial = ['a', 'b', 'c'].map(id => reminder(id));
    const { group, render, onReorder } = harness(initial);
    render(initial.filter(item => item.id !== 'b'));
    group.props.onReorder([...group.props.values].reverse());
    expect(onReorder).not.toHaveBeenCalled();
  });

  it('commits the full reordered list when drag end runs before the next render', () => {
    const { group, onReorderCommit, onDragActiveChange } = harness(['a', 'b', 'c'].map(id => reminder(id)));
    const row = group.props.children.props.children[0]!;
    row.props.onDragStart();
    group.props.onReorder([...group.props.values].reverse());
    row.props.onDragEnd();
    expect(onReorderCommit).toHaveBeenCalledExactlyOnceWith(['b', 'a', 'c']);
    expect(onDragActiveChange.mock.calls).toEqual([[true], [false]]);
  });
});
