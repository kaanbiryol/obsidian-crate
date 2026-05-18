import { describe, it, expect, vi } from 'vitest';
import { createMarkdownWriter } from '@/reminders/data/markdown-writer';
import type { MarkdownWriter } from '@/reminders/data/markdown-writer';
import type { ReminderIndex, IndexedReminder } from '@/reminders/data/reminder-index';
import { timezone as getLocalTimeZone } from '@/reminders/utils/time';
import { createMockAppWithVault } from '@/test/factories/obsidian';

type ReminderChangeCallback = Parameters<MarkdownWriter['setOnReminderChange']>[0];

function createMockIndex(overrides: Partial<ReminderIndex> = {}): ReminderIndex {
  return {
    remindersFolderPath: 'Reminders',
    applyOptimisticCreate: vi.fn(),
    applyOptimisticUpdate: vi.fn(),
    applyOptimisticDelete: vi.fn(),
    ...overrides,
  } as unknown as ReminderIndex;
}

function makeIndexedReminder(overrides: Partial<IndexedReminder>): IndexedReminder {
  return {
    id: overrides.id || 'r1',
    content: overrides.content || 'Task',
    dueDate: overrides.dueDate,
    dueDatetime: overrides.dueDatetime,
    priority: overrides.priority ?? 4,
    completed: overrides.completed ?? false,
    project: overrides.project,
    recurrence: overrides.recurrence,
    filePath: overrides.filePath || 'Reminders/Work.md',
    lineNumber: overrides.lineNumber ?? 0,
    rawLine: overrides.rawLine || '- [ ] Task',
    contentHash: overrides.contentHash || 'hash',
  };
}

describe('markdownWriter', () => {
  it('creates a reminder file and appends a new line', async () => {
    const { app, files, folders } = createMockAppWithVault();
    const index = createMockIndex();
    const writer = createMarkdownWriter(app, index);

    const onChange = vi.fn<ReminderChangeCallback>(async () => ({ success: true }));
    writer.setOnReminderChange(onChange);

    const dueDate = new Date(2026, 0, 13, 12, 0);
    await writer.createReminder('Work', 'Task A', dueDate, 1);

    expect(folders.has('Reminders')).toBe(true);
    const content = files.get('Reminders/Work.md') || '';
    expect(content).toContain('# Work');
    expect(content).toContain('- [ ] Task A');
    expect(content).toContain('Jan 13, 2026 12:00');
    expect(content).toContain('!');
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('updates a reminder when the line moved and rawLine no longer matches', async () => {
    const initial = '# Work\n\n- [ ] Task A Jan 1, 2026\n- [ ] Task B Jan 2, 2026\n';
    const { app, files, folders } = createMockAppWithVault({ 'Reminders/Work.md': initial });
    folders.add('Reminders');

    const index = createMockIndex();
    const writer = createMarkdownWriter(app, index);

    const reminder = makeIndexedReminder({
      id: 'r2',
      content: 'Task B',
      filePath: 'Reminders/Work.md',
      lineNumber: 1,
      rawLine: '- [ ] Task X',
      dueDate: '2026-01-02',
    });

    await writer.updateReminder(reminder, { content: 'Task B updated' });

    const content = files.get('Reminders/Work.md') || '';
    expect(content).toContain('Task B updated');
  });

  it('updates the correct duplicate reminder by persisted ID', async () => {
    const initial = [
      '# Work',
      '',
      '- [ ] Task A Jan 1, 2026 <!-- crate-id:rem-1 -->',
      '- [ ] Task A Jan 1, 2026 <!-- crate-id:rem-2 -->',
      '',
    ].join('\n');
    const { app, files, folders } = createMockAppWithVault({ 'Reminders/Work.md': initial });
    folders.add('Reminders');

    const index = createMockIndex();
    const writer = createMarkdownWriter(app, index);

    const reminder = makeIndexedReminder({
      id: 'rem-2',
      content: 'Task A',
      filePath: 'Reminders/Work.md',
      lineNumber: 2,
      rawLine: '- [ ] Task A Jan 1, 2026 <!-- crate-id:rem-2 -->',
      dueDate: '2026-01-01',
    });

    await writer.updateReminder(reminder, { content: 'Task A updated' });

    const content = files.get('Reminders/Work.md') || '';
    expect(content).toContain('- [ ] Task A Jan 1, 2026 <!-- crate-id:rem-1 -->');
    expect(content).toContain('- [ ] Task A updated Jan 1, 2026 <!-- crate-id:rem-2 -->');
  });

  it('preserves reminder ID metadata when updating content', async () => {
    const initial = '# Work\n\n- [ ] Task A Jan 1, 2026 <!-- crate-id:rem-1 -->\n';
    const { app, files, folders } = createMockAppWithVault({ 'Reminders/Work.md': initial });
    folders.add('Reminders');

    const index = createMockIndex();
    const writer = createMarkdownWriter(app, index);

    const reminder = makeIndexedReminder({
      id: 'rem-1',
      content: 'Task A',
      filePath: 'Reminders/Work.md',
      lineNumber: 2,
      rawLine: '- [ ] Task A Jan 1, 2026 <!-- crate-id:rem-1 -->',
      dueDate: '2026-01-01',
    });

    await writer.updateReminder(reminder, { content: 'Task A updated' });

    const content = files.get('Reminders/Work.md') || '';
    expect(content).toContain('<!-- crate-id:rem-1 -->');
    expect(content).toContain('Task A updated');
  });

  it('preserves date-only due dates when updating other fields', async () => {
    const initial = '# Work\n\n- [ ] Task D Jan 2, 2026\n';
    const { app, files, folders } = createMockAppWithVault({ 'Reminders/Work.md': initial });
    folders.add('Reminders');

    const index = createMockIndex();
    const writer = createMarkdownWriter(app, index);

    const reminder = makeIndexedReminder({
      id: 'r-date-only',
      content: 'Task D',
      filePath: 'Reminders/Work.md',
      lineNumber: 2,
      rawLine: '- [ ] Task D Jan 2, 2026',
      dueDate: '2026-01-02',
    });

    await writer.updateReminder(reminder, { content: 'Task D updated' });

    const content = files.get('Reminders/Work.md') || '';
    expect(content).toContain('Task D updated Jan 2, 2026');
    expect(content).not.toContain('00:00');
  });

  it('advances recurring reminders on toggleComplete without marking complete', async () => {
    const initial = '# Work\n\n- [ ] Task C Jan 1, 2026 10:00\n';
    const { app, files, folders } = createMockAppWithVault({ 'Reminders/Work.md': initial });
    folders.add('Reminders');

    const index = createMockIndex();
    const writer = createMarkdownWriter(app, index);

    const onChange = vi.fn<ReminderChangeCallback>(async () => ({ success: true }));
    writer.setOnReminderChange(onChange);

    const reminder = makeIndexedReminder({
      id: 'r3',
      content: 'Task C',
      filePath: 'Reminders/Work.md',
      lineNumber: 2,
      rawLine: '- [ ] Task C Jan 1, 2026 10:00',
      dueDatetime: '2026-01-01T10:00:00.000Z',
      dueDate: '2026-01-01',
      recurrence: { frequency: 'daily' },
      completed: false,
      priority: 4,
    });

    await writer.toggleComplete(reminder);

    const content = files.get('Reminders/Work.md') || '';
    expect(content).toContain('- [ ] Task C');
    expect(content).toContain('Jan 2, 2026');

    expect(onChange).toHaveBeenCalledTimes(1);
    const updated = onChange.mock.calls[0]?.[0];
    expect(updated).toBeDefined();
    expect(updated.completed).toBe(false);
    expect(updated.dueDate).toBe('2026-01-02');
  });

  it('creates a recurring reminder without dueDate using first occurrence', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 0, 10, 9, 0, 0));

    const { app, files } = createMockAppWithVault();
    const index = createMockIndex();
    const writer = createMarkdownWriter(app, index);

    const onChange = vi.fn<ReminderChangeCallback>(async () => ({ success: true }));
    writer.setOnReminderChange(onChange);

    await writer.createReminder('Work', 'Task D', undefined, 4, {
      frequency: 'daily',
      hour: 14,
      minute: 30,
    });

    const content = files.get('Reminders/Work.md') || '';
    expect(content).toContain('Task D');
    expect(content).toContain('daily 14:30');
    expect(content).toContain('Jan 10, 2026');
  });

  it('creates an all-day recurring reminder without leaking the current clock time', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-10T10:00:00.000Z'));

    const { app, files } = createMockAppWithVault();
    const index = createMockIndex();
    const writer = createMarkdownWriter(app, index);

    const onChange = vi.fn<ReminderChangeCallback>(async () => ({ success: true }));
    writer.setOnReminderChange(onChange);

    await writer.createReminder('Work', 'Task all day', undefined, 4, {
      frequency: 'daily',
    });

    const content = files.get('Reminders/Work.md') || '';
    expect(content).toContain('Task all day');
    expect(content).toContain('daily');
    expect(content).toContain('Jan 10, 2026');
    expect(content).not.toContain('10:00');

    const updated = onChange.mock.calls[0]?.[0];
    expect(updated?.dueDate).toBe('2026-01-10');
    expect(updated?.dueDatetime).toBeUndefined();
    expect(updated?.recurrence?.timezone).toBe(getLocalTimeZone());

    vi.useRealTimers();
  });

  it('moves a reminder to a new project file when project changes', async () => {
    const initial = '# Work\n\n- [ ] Task Move Jan 1, 2026\n';
    const { app, files, folders } = createMockAppWithVault({ 'Reminders/Work.md': initial });
    folders.add('Reminders');

    const index = createMockIndex();
    const writer = createMarkdownWriter(app, index);

    const reminder = makeIndexedReminder({
      id: 'r-move',
      content: 'Task Move',
      filePath: 'Reminders/Work.md',
      lineNumber: 2,
      rawLine: '- [ ] Task Move Jan 1, 2026',
      dueDate: '2026-01-01',
    });

    await writer.updateReminder(reminder, {
      project: 'Personal',
      content: 'Task Move',
      dueDate: new Date(2026, 0, 1),
    });

    const oldContent = files.get('Reminders/Work.md') || '';
    const newContent = files.get('Reminders/Personal.md') || '';

    expect(oldContent).not.toContain('Task Move');
    expect(newContent).toContain('Task Move');
  });

  it('deletes the reminder line together with its description block', async () => {
    const initial = [
      '# Work',
      '',
      '- [ ] Task A Jan 1, 2026 <!-- crate-id:r-delete -->',
      '<!-- crate-desc:extra details -->',
      '- [ ] Task B Jan 2, 2026 <!-- crate-id:r-keep -->',
      '',
    ].join('\n');
    const { app, files, folders } = createMockAppWithVault({ 'Reminders/Work.md': initial });
    folders.add('Reminders');

    const index = createMockIndex();
    const writer = createMarkdownWriter(app, index);

    const reminder = makeIndexedReminder({
      id: 'r-delete',
      content: 'Task A',
      filePath: 'Reminders/Work.md',
      lineNumber: 2,
      rawLine: '- [ ] Task A Jan 1, 2026 <!-- crate-id:r-delete -->',
      dueDate: '2026-01-01',
      description: 'extra details',
    });

    await writer.deleteReminder(reminder);

    const content = files.get('Reminders/Work.md') || '';
    expect(content).not.toContain('Task A');
    expect(content).not.toContain('crate-desc:extra details');
    expect(content).toContain('Task B');
  });

  it('reorders active reminders while preserving descriptions, completed items, and surrounding content', async () => {
    const initial = [
      '# Work',
      '',
      '- [ ] First Jan 1, 2026 <!-- crate-id:r1 -->',
      '<!-- crate-desc:first note -->',
      '- [ ] Second Jan 2, 2026 <!-- crate-id:r2 -->',
      '- [x] Done Jan 3, 2026 <!-- crate-id:r3 -->',
      '',
      'Footer',
      '',
    ].join('\n');
    const { app, files, folders } = createMockAppWithVault({ 'Reminders/Work.md': initial });
    folders.add('Reminders');

    const index = createMockIndex();
    const writer = createMarkdownWriter(app, index);

    await writer.reorderReminders('Reminders/Work.md', ['r2', 'r1']);

    const lines = (files.get('Reminders/Work.md') || '').split('\n');
    const secondIndex = lines.findIndex((line) => line.includes('Second Jan 2, 2026'));
    const firstIndex = lines.findIndex((line) => line.includes('First Jan 1, 2026'));
    const descIndex = lines.findIndex((line) => line.includes('crate-desc:first note'));
    const doneIndex = lines.findIndex((line) => line.includes('Done Jan 3, 2026'));
    const footerIndex = lines.findIndex((line) => line === 'Footer');

    expect(secondIndex).toBeGreaterThan(0);
    expect(firstIndex).toBeGreaterThan(secondIndex);
    expect(descIndex).toBe(firstIndex + 1);
    expect(doneIndex).toBeGreaterThan(descIndex);
    expect(footerIndex).toBeGreaterThan(doneIndex);
  });

  it('removes recurrence when update explicitly clears it', async () => {
    const dueDate = new Date(2026, 0, 1, 9, 0);
    const initial = '# Work\n\n- [ ] Task Repeat every day Jan 1, 2026 09:00\n';
    const { app, files, folders } = createMockAppWithVault({ 'Reminders/Work.md': initial });
    folders.add('Reminders');

    const index = createMockIndex();
    const writer = createMarkdownWriter(app, index);

    const reminder = makeIndexedReminder({
      id: 'r-clear-recurrence',
      content: 'Task Repeat',
      filePath: 'Reminders/Work.md',
      lineNumber: 2,
      rawLine: '- [ ] Task Repeat every day Jan 1, 2026 09:00',
      dueDatetime: dueDate.toISOString(),
      dueDate: dueDate.toISOString().split('T')[0],
      recurrence: { frequency: 'daily' },
    });

    await writer.updateReminder(reminder, {
      recurrence: null,
      dueDate,
    });

    const content = files.get('Reminders/Work.md') || '';
    expect(content).toContain('Task Repeat');
    expect(content).toContain('Jan 1, 2026 09:00');
    expect(content).not.toContain('every day');
  });

  it('preserves recurrence when moving a reminder to a new project file', async () => {
    const dueDate = new Date(2026, 0, 1, 9, 0);
    const initial = '# Work\n\n- [ ] Task Move every day Jan 1, 2026 09:00\n';
    const { app, files, folders } = createMockAppWithVault({ 'Reminders/Work.md': initial });
    folders.add('Reminders');

    const index = createMockIndex();
    const writer = createMarkdownWriter(app, index);

    const reminder = makeIndexedReminder({
      id: 'r-move-recurring',
      content: 'Task Move',
      filePath: 'Reminders/Work.md',
      lineNumber: 2,
      rawLine: '- [ ] Task Move every day Jan 1, 2026 09:00',
      dueDatetime: dueDate.toISOString(),
      dueDate: dueDate.toISOString().split('T')[0],
      recurrence: { frequency: 'daily' },
    });

    await writer.updateReminder(reminder, {
      project: 'Personal',
      dueDate,
    });

    const newContent = files.get('Reminders/Personal.md') || '';
    expect(newContent).toContain('Task Move');
    expect(newContent).toContain('daily');
  });
});
