import { describe, it, expect, beforeEach } from 'vitest';
import { LineReminderMappingService } from '@/reminders/services/lineReminderMapping';
import type { Reminder } from '@/reminders/types/reminder';

function makeReminder(id: string, content: string): Reminder {
  return {
    id,
    content,
    priority: 4,
    completed: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('LineReminderMappingService', () => {
  let service: LineReminderMappingService;

  beforeEach(() => {
    service = new LineReminderMappingService();
  });

  it('registers and resolves mappings in both directions', () => {
    service.registerLine('file.md', 3, 'r1', 'Task A');

    expect(service.getReminderForLine('file.md', 3)).toBe('r1');
    expect(service.getLineForReminder('r1')).toEqual({ filePath: 'file.md', lineNumber: 3 });
  });

  it('shifts lines and updates reverse map', () => {
    service.registerLine('file.md', 1, 'r1', 'Task A');
    service.registerLine('file.md', 2, 'r2', 'Task B');
    service.registerLine('file.md', 3, 'r3', 'Task C');

    service.shiftLines('file.md', 2, 2);

    expect(service.getReminderForLine('file.md', 1)).toBe('r1');
    expect(service.getReminderForLine('file.md', 4)).toBe('r2');
    expect(service.getReminderForLine('file.md', 5)).toBe('r3');
    expect(service.getLineForReminder('r2')).toEqual({ filePath: 'file.md', lineNumber: 4 });
  });

  it('drops mappings when shifted before line 0', () => {
    service.registerLine('file.md', 0, 'r1', 'Task A');

    service.shiftLines('file.md', 0, -1);

    expect(service.getReminderForLine('file.md', 0)).toBeUndefined();
    expect(service.getLineForReminder('r1')).toBeUndefined();
  });

  it('reconciles reminders with checkbox lines', () => {
    const reminders = [
      makeReminder('r1', 'Task A'),
      makeReminder('r2', 'Task A'),
      makeReminder('r3', 'Task D'),
    ];
    const checkboxLines = [
      { lineNumber: 0, content: 'Task A' },
      { lineNumber: 1, content: 'Task A' },
      { lineNumber: 2, content: 'Task C' },
    ];

    const result = service.reconcile('file.md', reminders, checkboxLines);

    expect(result.matched).toHaveLength(2);
    expect(result.orphaned).toHaveLength(1);
    expect(result.unmapped).toHaveLength(1);

    expect(service.getReminderForLine('file.md', 0)).toBeDefined();
    expect(service.getReminderForLine('file.md', 1)).toBeDefined();
  });

  it('prefers persisted reminder IDs over content matching for duplicates', () => {
    const reminders = [
      makeReminder('r1', 'Task A'),
      makeReminder('r2', 'Task A'),
    ];
    const checkboxLines = [
      { lineNumber: 0, content: 'Task A', reminderId: 'r2' },
      { lineNumber: 1, content: 'Task A', reminderId: 'r1' },
    ];

    const result = service.reconcile('file.md', reminders, checkboxLines);

    expect(result.matched).toEqual([
      { lineNumber: 1, reminder: reminders[0] },
      { lineNumber: 0, reminder: reminders[1] },
    ]);
    expect(service.getReminderForLine('file.md', 0)).toBe('r2');
    expect(service.getReminderForLine('file.md', 1)).toBe('r1');
  });
});
