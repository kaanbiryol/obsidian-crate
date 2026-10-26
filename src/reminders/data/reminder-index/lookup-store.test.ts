import { expect, it } from 'vitest';
import type { IndexedReminder } from '@/reminders/data/reminder-index';
import { createReminderLookupStore } from './lookup-store';

function reminder(id: string, filePath: string, project?: string): IndexedReminder {
  return { id, content: id, priority: 4, completed: false, project, filePath, lineNumber: 0, rawLine: `- [ ] ${id}` };
}

it('keeps a project while any file still has reminders in it', () => {
  const store = createReminderLookupStore();
  store.rebuild([reminder('a', 'A.md', 'Work'), reminder('b', 'B.md', 'Work'), reminder('c', 'B.md', 'Home')]);

  store.removeFile('A.md');
  expect(store.getProjects(new Set())).toEqual(['Home', 'Work']);

  store.removeFile('B.md');
  expect(store.getProjects(new Set(['Idea']))).toEqual(['Idea']);
});

it('removes a large single-project file in linear time', () => {
  const store = createReminderLookupStore();
  const count = 30_000;
  store.rebuild(Array.from({ length: count }, (_, i) => reminder(`r${i}`, 'Big.md', 'Work')));

  const started = performance.now();
  expect(store.removeFile('Big.md')).toHaveLength(count);
  // Before: about 3 seconds on an M-series Mac, growing with the square of the reminder count.
  expect(performance.now() - started).toBeLessThan(1_000);
  expect(store.getProjects(new Set())).toEqual([]);
  expect(store.getById('r0')).toBeUndefined();
});
