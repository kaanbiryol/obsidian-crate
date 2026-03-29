import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TFile, type App } from 'obsidian';

vi.mock('@/reminders/data/vaultScanner', () => ({
  scanVault: vi.fn(),
  scanFile: vi.fn(),
  isInRemindersFolder: vi.fn(),
  getProjectFromPath: vi.fn(),
}));

import { createReminderIndex, type IndexedReminder } from '@/reminders/data/reminderIndex';
import * as vaultScanner from '@/reminders/data/vaultScanner';
import type { ScanResult } from '@/reminders/data/vaultScanner';

type ScanFileResult = {
  filePath: string;
  reminders: IndexedReminder[];
  lineCount: number;
};

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

function makeReminder(overrides: Partial<IndexedReminder>): IndexedReminder {
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

describe('reminderIndex', () => {
  const app = { vault: {} } as unknown as App;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('filters today, upcoming, and overdue reminders correctly', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-10T12:00:00Z'));

    const reminders = [
      makeReminder({ id: 'today', dueDate: '2026-01-10', completed: false }),
      makeReminder({ id: 'upcoming', dueDatetime: '2026-01-12T09:00:00.000Z', completed: false }),
      makeReminder({ id: 'overdue', dueDate: '2026-01-05', completed: false }),
      makeReminder({ id: 'done', dueDate: '2026-01-05', completed: true }),
    ];

    const scanResult: ScanResult = {
      reminders,
      filesScanned: 1,
      totalLines: 4,
      scanDurationMs: 10,
      discoveredProjects: ['Work'],
    };

    vi.mocked(vaultScanner.scanVault).mockResolvedValue(scanResult);

    const index = createReminderIndex(app, 'Reminders');
    await index.load();

    expect(index.getToday().map(r => r.id)).toEqual(['today']);
    expect(index.getUpcoming(3).map(r => r.id)).toEqual(['upcoming']);
    expect(index.getOverdue().map(r => r.id)).toEqual(['overdue']);
  });

  it('updates indexes when renaming files', () => {
    const reminders = [
      makeReminder({ id: 'r1', project: 'Old', filePath: 'Reminders/Old.md' }),
      makeReminder({ id: 'r2', project: 'Old', filePath: 'Reminders/Old.md', lineNumber: 1 }),
    ];

    const scanResult: ScanResult = {
      reminders,
      filesScanned: 1,
      totalLines: 2,
      scanDurationMs: 5,
      discoveredProjects: ['Old'],
    };

    vi.mocked(vaultScanner.scanVault).mockResolvedValue(scanResult);
    vi.mocked(vaultScanner.getProjectFromPath)
      .mockImplementation((path: string) => (path.includes('Old') ? 'Old' : 'New'));

    const index = createReminderIndex(app, 'Reminders');
    return index.load().then(() => {
      index.renameFile('Reminders/Old.md', 'Reminders/New.md');

      expect(index.getByFile('Reminders/New.md')).toHaveLength(2);
      expect(index.getByProject('New')).toHaveLength(2);
      expect(index.getByProject('Old')).toHaveLength(0);
      expect(index.getProjects()).toEqual(['New']);
    });
  });

  it('debounces rescans for the same file', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-10T12:00:00Z'));

    vi.mocked(vaultScanner.isInRemindersFolder).mockReturnValue(true);
    vi.mocked(vaultScanner.getProjectFromPath).mockReturnValue('Work');
    const scanFileResult: ScanFileResult = {
      filePath: 'Reminders/Work.md',
      reminders: [makeReminder({ id: 'r1' })],
      lineCount: 1,
    };
    vi.mocked(vaultScanner.scanFile).mockResolvedValue(scanFileResult);

    const index = createReminderIndex(app, 'Reminders');
    const file = makeMockFile('Reminders/Work.md');

    await index.rescanFile(file);
    await index.rescanFile(file);

    expect(vi.mocked(vaultScanner.scanFile)).toHaveBeenCalledTimes(1);
  });

  it('removes a file from indexes and projects', async () => {
    const reminders = [
      makeReminder({ id: 'r1', project: 'Work', filePath: 'Reminders/Work.md' }),
      makeReminder({ id: 'r2', project: 'Home', filePath: 'Reminders/Home.md' }),
    ];

    const scanResult: ScanResult = {
      reminders,
      filesScanned: 2,
      totalLines: 2,
      scanDurationMs: 5,
      discoveredProjects: ['Work', 'Home'],
    };

    vi.mocked(vaultScanner.scanVault).mockResolvedValue(scanResult);
    vi.mocked(vaultScanner.getProjectFromPath)
      .mockImplementation((path: string) => (path.includes('Work') ? 'Work' : 'Home'));

    const index = createReminderIndex(app, 'Reminders');
    await index.load();

    index.removeFile('Reminders/Work.md');

    expect(index.getByFile('Reminders/Work.md')).toHaveLength(0);
    expect(index.getByProject('Work')).toHaveLength(0);
    expect(index.getProjects()).toEqual(['Home']);
  });

  it('notifies listeners on index changes', async () => {
    const reminders = [
      makeReminder({ id: 'r1', project: 'Work', filePath: 'Reminders/Work.md' }),
    ];

    const scanResult: ScanResult = {
      reminders,
      filesScanned: 1,
      totalLines: 1,
      scanDurationMs: 5,
      discoveredProjects: ['Work'],
    };

    vi.mocked(vaultScanner.scanVault).mockResolvedValue(scanResult);
    vi.mocked(vaultScanner.getProjectFromPath).mockReturnValue('Work');

    const index = createReminderIndex(app, 'Reminders');
    const listener = vi.fn();
    index.onIndexChange(listener);

    await index.load();
    listener.mockClear();

    index.removeFile('Reminders/Work.md');

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('rescans after debounce window elapses', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-10T12:00:00Z'));

    vi.mocked(vaultScanner.isInRemindersFolder).mockReturnValue(true);
    vi.mocked(vaultScanner.getProjectFromPath).mockReturnValue('Work');
    const scanFileResult: ScanFileResult = {
      filePath: 'Reminders/Work.md',
      reminders: [makeReminder({ id: 'r1' })],
      lineCount: 1,
    };
    vi.mocked(vaultScanner.scanFile).mockResolvedValue(scanFileResult);

    const index = createReminderIndex(app, 'Reminders');
    const file = makeMockFile('Reminders/Work.md');

    await index.rescanFile(file);
    vi.advanceTimersByTime(1600);
    await index.rescanFile(file);

    expect(vi.mocked(vaultScanner.scanFile)).toHaveBeenCalledTimes(2);
  });
});
