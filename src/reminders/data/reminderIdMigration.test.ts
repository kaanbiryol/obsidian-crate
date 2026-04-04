import { describe, it, expect, vi } from 'vitest';
import { TFile, type App } from 'obsidian';
import { migrateReminderIds } from '@/reminders/data/reminderIdMigration';

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

describe('migrateReminderIds', () => {
  it('adds fresh reminder identifiers to plain markdown reminder lines', async () => {
    const file = makeMockFile('Reminders/Work.md');
    const contents = new Map<string, string>([
      ['Reminders/Work.md', '- [ ] Task A\n- [ ] Task A\n'],
    ]);

    const app = {
      vault: {
        getMarkdownFiles: vi.fn(() => [file]),
        cachedRead: vi.fn(async (target: TFile) => contents.get(target.path) || ''),
        modify: vi.fn(async (target: TFile, content: string) => {
          contents.set(target.path, content);
        }),
      },
    } as unknown as App;

    const result = await migrateReminderIds(app, 'Reminders');

    expect(result.filesUpdated).toBe(1);
    expect(result.remindersUpdated).toBe(2);
    const migrated = contents.get('Reminders/Work.md') || '';
    expect(migrated).toMatch(/crate-id:/);
    const ids = [...migrated.matchAll(/crate-id:([^\s>]+)/g)].map((match) => match[1]);
    expect(ids).toHaveLength(2);
    expect(ids[0]).not.toBe(ids[1]);
    for (const id of ids) {
      expect(id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      );
    }
  });
});
