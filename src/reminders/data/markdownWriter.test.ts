import { describe, it, expect, vi } from 'vitest';
import { createMarkdownWriter } from '@/reminders/data/markdownWriter';
import type { MarkdownWriter } from '@/reminders/data/markdownWriter';
import type { ReminderIndex, IndexedReminder } from '@/reminders/data/reminderIndex';
import { timezone as getLocalTimeZone } from '@/reminders/utils/time';
import { TFile, type App } from 'obsidian';

type MockVault = {
  adapter: {
    exists: ReturnType<typeof vi.fn<(path: string) => Promise<boolean>>>;
  };
  getAbstractFileByPath: ReturnType<typeof vi.fn<(path: string) => TFile | null>>;
  createFolder: ReturnType<typeof vi.fn<(path: string) => Promise<void>>>;
  create: ReturnType<typeof vi.fn<(path: string, content: string) => Promise<void>>>;
  read: ReturnType<typeof vi.fn<(file: TFile) => Promise<string>>>;
  modify: ReturnType<typeof vi.fn<(file: TFile, content: string) => Promise<void>>>;
};

type MockAppResult = {
  app: App;
  files: Map<string, string>;
  folders: Set<string>;
  vault: MockVault;
};

type ReminderChangeCallback = Parameters<MarkdownWriter['setOnReminderChange']>[0];

function makeMockFile(path: string): TFile {
  const file = new TFile();
  const name = path.split('/').pop() ?? path;
  const dotIndex = name.lastIndexOf('.');

  file.vault = {} as never;
  file.path = path;
  file.name = name;
  file.parent = null;
  file.basename = dotIndex >= 0 ? name.slice(0, dotIndex) : name;
  file.extension = dotIndex >= 0 ? name.slice(dotIndex + 1) : '';
  file.stat = { ctime: 0, mtime: 0, size: 0 };

  return file;
}

function createMockApp(initialFiles: Record<string, string> = {}): MockAppResult {
  const files = new Map(Object.entries(initialFiles));
  const folders = new Set<string>();

  const vault: MockVault = {
    adapter: {
      exists: vi.fn(async (path: string) => folders.has(path) || files.has(path)),
    },
    getAbstractFileByPath: vi.fn((path: string) =>
      files.has(path) ? makeMockFile(path) : null
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

  return { app: { vault } as unknown as App, files, folders, vault };
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

  it('preserves date-only due dates when updating other fields', async () => {
    const initial = '# Work\n\n- [ ] Task D Jan 2, 2026\n';
    const { app, files, folders } = createMockApp({ 'Reminders/Work.md': initial });
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
    const { app, files, folders } = createMockApp({ 'Reminders/Work.md': initial });
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

    const { app, files } = createMockApp();
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

    const { app, files } = createMockApp();
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

  it('removes recurrence when update explicitly clears it', async () => {
    const dueDate = new Date(2026, 0, 1, 9, 0);
    const initial = '# Work\n\n- [ ] Task Repeat every day Jan 1, 2026 09:00\n';
    const { app, files, folders } = createMockApp({ 'Reminders/Work.md': initial });
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
    const { app, files, folders } = createMockApp({ 'Reminders/Work.md': initial });
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
