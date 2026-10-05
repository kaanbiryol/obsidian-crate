import { beforeEach, expect, it, vi } from 'vitest';
import { TFile, type App } from 'obsidian';
import { createReminderIndex, type IndexedReminder } from './index';
import { scanFile, scanVault, type FileScanResult, type ScanResult } from '../vaultScanner';

vi.mock('../vaultScanner', () => ({
  scanFile: vi.fn(), scanVault: vi.fn(),
  isInRemindersFolder: (path: string) => path.startsWith('Reminders/'),
  getProjectFromPath: (path: string) => path.split('/').pop()!.replace(/\.md$/, ''),
}));
const oldPath = 'Reminders/Old.md', newPath = 'Reminders/New.md';
function reminder(filePath = oldPath): IndexedReminder {
  return { id: 'one', content: 'Task', priority: 4, completed: false, filePath,
    project: filePath === oldPath ? 'Old' : 'New', lineNumber: 0, rawLine: '- [ ] Task', contentHash: 'hash' };
}
function snapshot(reminders: IndexedReminder[]): ScanResult {
  return { reminders, issues: [], filesScanned: reminders.length, totalLines: reminders.length,
    discoveredProjects: reminders.map(item => item.project!), scanDurationMs: 1 };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
async function harness() {
  const index = createReminderIndex({ vault: {} } as App, 'Reminders');
  vi.mocked(scanVault).mockResolvedValue(snapshot([reminder()]));
  await index.load();
  const file = Object.assign(new TFile(), { path: oldPath, extension: 'md' });
  return { index, file };
}
beforeEach(() => vi.resetAllMocks());

it.each(['delete', 'rename'] as const)('does not publish a late file scan after %s', async action => {
  const { index, file } = await harness();
  const started = deferred<void>(), result = deferred<FileScanResult>();
  vi.mocked(scanFile).mockImplementation(async () => { started.resolve(); return result.promise; });
  const scanning = index.rescanFile(file);
  await started.promise;
  if (action === 'delete') index.removeFile(oldPath);
  else { file.path = newPath; index.renameFile(oldPath, newPath); }
  result.resolve({ filePath: oldPath, reminders: [reminder()], lineCount: 1 });
  await scanning;
  expect(index.getByFile(oldPath)).toEqual([]);
  expect(index.getAll()).toEqual(action === 'delete' ? [] : [reminder(newPath)]);
});

it('does not restore a deleted-file warning from a late failed scan', async () => {
  const { index, file } = await harness();
  const started = deferred<void>(), result = deferred<FileScanResult>();
  vi.mocked(scanFile).mockImplementation(async () => { started.resolve(); return result.promise; });
  const scanning = index.rescanFile(file);
  await started.promise;
  index.removeFile(oldPath);
  result.resolve({ filePath: oldPath, reminders: [], lineCount: 0, error: 'File is gone' });
  await scanning;
  expect(index.sourceIssues).toEqual([]);
  expect(index.isComplete).toBe(true);
});

it.each(['delete', 'rename'] as const)('re-reads a whole-vault snapshot invalidated by %s', async action => {
  const { index, file } = await harness();
  const started = deferred<void>(), result = deferred<ScanResult>();
  vi.mocked(scanVault).mockImplementationOnce(async () => { started.resolve(); return result.promise; });
  const scanning = index.load();
  await started.promise;
  const current = action === 'delete' ? [] : [reminder(newPath)];
  if (action === 'delete') index.removeFile(oldPath);
  else { file.path = newPath; index.renameFile(oldPath, newPath); }
  vi.mocked(scanVault).mockResolvedValue(snapshot(current));
  result.resolve(snapshot([reminder()]));
  await scanning;
  expect(index.getAll()).toEqual(current);
  expect(index.getProjects()).toEqual(action === 'delete' ? [] : ['New']);
  expect(index.isComplete).toBe(true);
});

it('invalidates a queued file scan before it starts, while allowing scans of a recreated file', async () => {
  const { index, file } = await harness();
  const started = deferred<void>(), result = deferred<ScanResult>();
  vi.mocked(scanVault).mockImplementationOnce(async () => { started.resolve(); return result.promise; });
  const loading = index.load();
  await started.promise;
  const scanning = index.rescanFile(file);
  index.removeFile(oldPath);
  vi.mocked(scanVault).mockResolvedValue(snapshot([]));
  result.resolve(snapshot([reminder()]));
  await Promise.all([loading, scanning]);
  expect(scanFile).not.toHaveBeenCalled();
  expect(index.getAll()).toEqual([]);
  vi.mocked(scanFile).mockResolvedValue({ filePath: oldPath, reminders: [reminder()], lineCount: 1 });
  await index.rescanFile(Object.assign(new TFile(), { path: oldPath, extension: 'md' }));
  expect(index.getById('one')).toEqual(reminder());
});

it('applies consecutive requested scans without dropping the newer content', async () => {
  const { index, file } = await harness();
  vi.mocked(scanFile).mockResolvedValueOnce({ filePath: oldPath, reminders: [reminder()], lineCount: 1 })
    .mockResolvedValueOnce({ filePath: oldPath, reminders: [{ ...reminder(), content: 'Newer edit' }], lineCount: 1 });
  await index.rescanFile(file);
  await index.rescanFile(file);
  expect(index.getById('one')?.content).toBe('Newer edit');
});

it('keeps all read views consistent through rename, a failed rescan and recovery', async () => {
  const { index, file } = await harness();
  const views = () => ({
    all: index.getAll(), byId: index.getById('one'),
    oldFile: index.getByFile(oldPath), newFile: index.getByFile(newPath),
    oldProject: index.getByProject('Old'), newProject: index.getByProject('New'),
    projects: index.getProjects(),
  });
  const published: ReturnType<typeof views>[] = [];
  index.onIndexChange(() => published.push(views()));
  file.path = newPath;
  index.renameFile(oldPath, newPath);
  const renamed = reminder(newPath);
  const expected = { all: [renamed], byId: renamed, oldFile: [], newFile: [renamed],
    oldProject: [], newProject: [renamed], projects: ['New'] };
  expect(views()).toEqual(expected);
  expect(published).toEqual([expected]);

  vi.mocked(scanFile).mockResolvedValueOnce({ filePath: newPath, reminders: [], lineCount: 0, error: 'Unreadable source' });
  await index.rescanFile(file);
  expect(views()).toEqual(expected);
  expect(index.sourceIssues).toEqual([{ path: newPath, reason: 'Unreadable source' }]);

  const edited = { ...renamed, content: 'Recovered edit' };
  vi.mocked(scanFile).mockResolvedValueOnce({ filePath: newPath, reminders: [edited], lineCount: 1 });
  await index.rescanFile(file);
  expect(views()).toEqual({ ...expected, all: [edited], byId: edited, newFile: [edited], newProject: [edited] });
  expect(index.sourceIssues).toEqual([]);
  index.removeFile(newPath);
  expect(views()).toEqual({ all: [], byId: undefined, oldFile: [], newFile: [], oldProject: [], newProject: [], projects: [] });
});
