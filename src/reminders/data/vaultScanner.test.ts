import { describe, it, expect, vi } from 'vitest';
import { getProjectFromPath, isInRemindersFolder, scanFile, scanVault } from '@/reminders/data/vaultScanner';
import { TFile, type App } from 'obsidian';

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

describe('vaultScanner', () => {
  it('derives project from path with nested folders and case-insensitive folder', () => {
    expect(getProjectFromPath('Reminders/Work.md', 'Reminders')).toBe('Work');
    expect(getProjectFromPath('Reminders/Personal/Health.md', 'Reminders')).toBe('Personal/Health');
    expect(getProjectFromPath('reminders/Inbox.md', 'Reminders')).toBe('Inbox');
  });

  it('detects files within reminders folder', () => {
    expect(isInRemindersFolder('Reminders/Work.md', 'Reminders')).toBe(true);
    expect(isInRemindersFolder('Notes/Work.md', 'Reminders')).toBe(false);
    expect(isInRemindersFolder('Reminders', 'Reminders')).toBe(true);
  });

  it('scans a file and ignores empty checkbox content', async () => {
    const app = {
      vault: {
        cachedRead: vi.fn().mockResolvedValue('- [ ] Task A\n- [ ] \n- [x] Done task'),
      },
    } as unknown as App;

    const file = makeMockFile('Reminders/Work.md');
    const result = await scanFile(app, file, 'Reminders');

    expect(result.reminders).toHaveLength(2);
    expect(result.reminders[0].content).toBe('Task A');
    expect(result.reminders[1].completed).toBe(true);
  });

  it('scans the vault and collects discovered projects', async () => {
    const files = [
      makeMockFile('Reminders/Work.md'),
      makeMockFile('Reminders/Empty.md'),
      makeMockFile('Notes/Other.md'),
    ];

    const contentByPath: Record<string, string> = {
      'Reminders/Work.md': '- [ ] Task A',
      'Reminders/Empty.md': 'No reminders here',
      'Notes/Other.md': '- [ ] Not included',
    };

    const app = {
      vault: {
        getMarkdownFiles: vi.fn().mockReturnValue(files),
        cachedRead: vi.fn((file: TFile) => Promise.resolve(contentByPath[file.path] || '')),
      },
    } as unknown as App;

    const result = await scanVault(app, 'Reminders');

    expect(result.filesScanned).toBe(2);
    expect(result.reminders).toHaveLength(1);
    expect(result.discoveredProjects).toEqual(['Empty', 'Work']);
  });

  it('falls back to getMarkdownFiles when getAbstractFileByPath is unavailable', async () => {
    const files = [
      makeMockFile('Reminders/Work.md'),
      makeMockFile('Notes/Other.md'),
    ];

    const contentByPath: Record<string, string> = {
      'Reminders/Work.md': '- [ ] Task A',
      'Notes/Other.md': '- [ ] Not included',
    };

    const app = {
      vault: {
        getMarkdownFiles: vi.fn().mockReturnValue(files),
        cachedRead: vi.fn((file: TFile) => Promise.resolve(contentByPath[file.path] || '')),
      },
    } as unknown as App;

    const result = await scanVault(app, 'Reminders');

    expect(result.filesScanned).toBe(1);
    expect(result.reminders).toHaveLength(1);
    expect(result.reminders[0].id).toBeTruthy();
  });
});
