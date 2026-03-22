import { describe, it, expect, vi } from 'vitest';
import { getProjectFromPath, isInRemindersFolder, scanFile, scanVault } from '@/reminders/data/vaultScanner';

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
    } as any;

    const file = { path: 'Reminders/Work.md' } as any;
    const result = await scanFile(app, file, 'Reminders');

    expect(result.reminders).toHaveLength(2);
    expect(result.reminders[0].content).toBe('Task A');
    expect(result.reminders[1].completed).toBe(true);
  });

  it('scans the vault and collects discovered projects', async () => {
    const files = [
      { path: 'Reminders/Work.md' },
      { path: 'Reminders/Empty.md' },
      { path: 'Notes/Other.md' },
    ];

    const contentByPath: Record<string, string> = {
      'Reminders/Work.md': '- [ ] Task A',
      'Reminders/Empty.md': 'No reminders here',
      'Notes/Other.md': '- [ ] Not included',
    };

    const app = {
      vault: {
        getMarkdownFiles: vi.fn().mockReturnValue(files),
        cachedRead: vi.fn((file: { path: string }) => Promise.resolve(contentByPath[file.path] || '')),
      },
    } as any;

    const result = await scanVault(app, 'Reminders');

    expect(result.filesScanned).toBe(2);
    expect(result.reminders).toHaveLength(1);
    expect(result.discoveredProjects).toEqual(['Empty', 'Work']);
  });

  it('falls back to getMarkdownFiles when getAbstractFileByPath is unavailable', async () => {
    const files = [
      { path: 'Reminders/Work.md' },
      { path: 'Notes/Other.md' },
    ];

    const contentByPath: Record<string, string> = {
      'Reminders/Work.md': '- [ ] Task A',
      'Notes/Other.md': '- [ ] Not included',
    };

    const app = {
      vault: {
        getMarkdownFiles: vi.fn().mockReturnValue(files),
        cachedRead: vi.fn((file: { path: string }) => Promise.resolve(contentByPath[file.path] || '')),
      },
    } as any;

    const result = await scanVault(app, 'Reminders');

    expect(result.filesScanned).toBe(1);
    expect(result.reminders).toHaveLength(1);
    expect(result.reminders[0].id).toBeTruthy();
  });
});
