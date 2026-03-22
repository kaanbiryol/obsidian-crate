import { describe, it, expect, vi } from 'vitest';
import { createMarkdownWriter } from '@/reminders/data/markdownWriter';
import type { ReminderIndex, IndexedReminder } from '@/reminders/data/reminderIndex';
import type { SyncResult } from '@/reminders/data/markdownWriter';

function createMockApp(initialFiles: Record<string, string> = {}) {
  const files = new Map(Object.entries(initialFiles));
  const folders = new Set<string>();

  const vault = {
    adapter: {
      exists: vi.fn(async (path: string) => folders.has(path) || files.has(path)),
    },
    getAbstractFileByPath: vi.fn((path: string) =>
      files.has(path) ? ({ path, extension: 'md' } as any) : null
    ),
    createFolder: vi.fn(async (path: string) => {
      folders.add(path);
    }),
    create: vi.fn(async (path: string, content: string) => {
      files.set(path, content);
    }),
    read: vi.fn(async (file: { path: string }) => files.get(file.path) || ''),
    modify: vi.fn(async (file: { path: string }, content: string) => {
      files.set(file.path, content);
    }),
  };

  return { app: { vault } as any, files, folders, vault };
}

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
    const { app, files, folders } = createMockApp();
    const index = createMockIndex();
    const writer = createMarkdownWriter(app, index);

    const onChange = vi.fn(async () => ({ success: true } as SyncResult));
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
    const { app, files, folders } = createMockApp({ 'Reminders/Work.md': initial });
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

  it('advances recurring reminders on toggleComplete without marking complete', async () => {
    const initial = '# Work\n\n- [ ] Task C Jan 1, 2026 10:00\n';
    const { app, files, folders } = createMockApp({ 'Reminders/Work.md': initial });
    folders.add('Reminders');

    const index = createMockIndex();
    const writer = createMarkdownWriter(app, index);

    const onChange = vi.fn(async () => ({ success: true } as SyncResult));
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
    const updated = (onChange.mock.calls as any[][])[0]![0];
    expect(updated.completed).toBe(false);
    expect(updated.dueDate).toBe('2026-01-02');
  });

  it('creates a recurring reminder without dueDate using first occurrence', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 0, 10, 9, 0, 0));

    const { app, files, folders } = createMockApp();
    const index = createMockIndex();
    const writer = createMarkdownWriter(app, index);

    const onChange = vi.fn(async () => ({ success: true } as SyncResult));
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

  it('moves a reminder to a new project file when project changes', async () => {
    const initial = '# Work\n\n- [ ] Task Move Jan 1, 2026\n';
    const { app, files, folders } = createMockApp({ 'Reminders/Work.md': initial });
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
});
