import { getLocalTimeZone } from '@internationalized/date';
import { describe, it, expect } from 'vitest';
import { parseReminderContent } from './reminderParser';

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
});
