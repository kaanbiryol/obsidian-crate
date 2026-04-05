import { getLocalTimeZone } from '@internationalized/date';
import { describe, it, expect } from 'vitest';
import { parseReminderContent, rebuildReminderContent } from './reminderParser';

describe('parseReminderContent hasTime', () => {
  it('returns hasTime false for "today" without explicit time', () => {
    const result = parseReminderContent('buy groceries today');
    expect(result.dueDate).toBeDefined();
    expect(result.hasTime).toBe(false);
    expect(result.dueDate!.getHours()).toBe(0);
    expect(result.dueDate!.getMinutes()).toBe(0);
    expect(result.cleanContent).toBe('buy groceries');
  });

  it('returns hasTime false for "tomorrow" without explicit time', () => {
    const result = parseReminderContent('call dentist tomorrow');
    expect(result.dueDate).toBeDefined();
    expect(result.hasTime).toBe(false);
    expect(result.dueDate!.getHours()).toBe(0);
    expect(result.dueDate!.getMinutes()).toBe(0);
  });

  it('returns hasTime true for "today at 3pm"', () => {
    const result = parseReminderContent('meeting today at 3pm');
    expect(result.dueDate).toBeDefined();
    expect(result.hasTime).toBe(true);
    expect(result.dueDate!.getHours()).toBe(15);
  });

  it('returns hasTime true for "tomorrow at 14:00"', () => {
    const result = parseReminderContent('standup tomorrow at 14:00');
    expect(result.dueDate).toBeDefined();
    expect(result.hasTime).toBe(true);
    expect(result.dueDate!.getHours()).toBe(14);
    expect(result.dueDate!.getMinutes()).toBe(0);
  });

  it('returns hasTime true for ISO datetime with T', () => {
    const result = parseReminderContent('task 2026-04-03T15:30');
    expect(result.dueDate).toBeDefined();
    expect(result.hasTime).toBe(true);
  });

  it('returns hasTime false for ISO date without T', () => {
    const result = parseReminderContent('task 2026-04-03');
    expect(result.dueDate).toBeDefined();
    expect(result.hasTime).toBe(false);
    expect(result.dueDate!.getHours()).toBe(0);
    expect(result.dueDate!.getMinutes()).toBe(0);
  });

  it('returns hasTime undefined when no date is present', () => {
    const result = parseReminderContent('just a task');
    expect(result.dueDate).toBeUndefined();
    expect(result.hasTime).toBeUndefined();
  });

  it('returns hasTime false for "next monday" without time', () => {
    const result = parseReminderContent('review PR next monday');
    expect(result.dueDate).toBeDefined();
    expect(result.hasTime).toBe(false);
    expect(result.dueDate!.getHours()).toBe(0);
  });

  it('adds timezone metadata to parsed recurrence rules', () => {
    const result = parseReminderContent('review inbox daily 15:00');
    expect(result.recurrence).toBeDefined();
    expect(result.recurrence?.timezone).toBe(getLocalTimeZone());
  });

  it('returns undefined dueDate for invalid ISO date strings', () => {
    const result = parseReminderContent('task 9999-99-99T25:00');
    expect(result.dueDate).toBeUndefined();
    expect(result.hasTime).toBeUndefined();
    expect(result.cleanContent).toContain('task');
  });
});

describe('rebuildReminderContent', () => {
  it('includes time when hasTime is true even at midnight', () => {
    const midnight = new Date(2026, 3, 3, 0, 0);
    const result = rebuildReminderContent('task', midnight, 4, true);
    expect(result).toBe('task 2026-04-03T00:00');
  });

  it('omits time when hasTime is false', () => {
    const noon = new Date(2026, 3, 3, 12, 30);
    const result = rebuildReminderContent('task', noon, 4, false);
    expect(result).toBe('task 2026-04-03');
  });

  it('omits time when hasTime is not provided (backward compat)', () => {
    const midnight = new Date(2026, 3, 3, 0, 0);
    const result = rebuildReminderContent('task', midnight, 4);
    expect(result).toBe('task 2026-04-03');
  });

  it('appends important marker when priority is 1', () => {
    const date = new Date(2026, 3, 3, 14, 0);
    const result = rebuildReminderContent('task', date, 1, true);
    expect(result).toBe('task 2026-04-03T14:00 !');
  });
});
