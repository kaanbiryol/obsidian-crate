import { describe, expect, it, vi } from 'vitest';
import { calculateFirstOccurrence, calculateNextOccurrence } from './recurrenceCalculator';

describe('recurrenceCalculator', () => {
  it('keeps later weekdays in the same active week for multi-week recurrences', () => {
    const next = calculateNextOccurrence(
      new Date('2026-01-05T10:00:00.000Z'),
      {
        frequency: 'weekly',
        interval: 2,
        daysOfWeek: [1, 3],
        hour: 10,
        minute: 0,
        timezone: 'UTC',
      },
    );

    expect(next?.toISOString()).toBe('2026-01-07T10:00:00.000Z');
  });

  it('preserves the current occurrence time when the rule has no explicit time', () => {
    const next = calculateNextOccurrence(
      new Date('2026-01-05T10:00:00.000Z'),
      {
        frequency: 'daily',
        timezone: 'UTC',
      },
    );

    expect(next?.toISOString()).toBe('2026-01-06T10:00:00.000Z');
  });

  it('preserves local wall-clock time across DST start', () => {
    const next = calculateNextOccurrence(
      new Date('2026-03-28T14:00:00.000Z'),
      {
        frequency: 'daily',
        hour: 15,
        minute: 0,
        timezone: 'Europe/Berlin',
      },
    );

    expect(next?.toISOString()).toBe('2026-03-29T13:00:00.000Z');
  });

  it('preserves local wall-clock time across DST end', () => {
    const next = calculateNextOccurrence(
      new Date('2026-10-24T13:00:00.000Z'),
      {
        frequency: 'daily',
        hour: 15,
        minute: 0,
        timezone: 'Europe/Berlin',
      },
    );

    expect(next?.toISOString()).toBe('2026-10-25T14:00:00.000Z');
  });

  it('chooses the next future occurrence when today time already passed', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-10T10:00:00.000Z'));

    const first = calculateFirstOccurrence({
      frequency: 'daily',
      hour: 9,
      minute: 0,
      timezone: 'UTC',
    });

    expect(first.toISOString()).toBe('2026-01-11T09:00:00.000Z');

    vi.useRealTimers();
  });

  it('chooses a later weekday in the same active week when today time already passed', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-05T11:00:00.000Z'));

    const first = calculateFirstOccurrence({
      frequency: 'weekly',
      interval: 2,
      daysOfWeek: [1, 3],
      hour: 10,
      minute: 0,
      timezone: 'UTC',
    });

    expect(first.toISOString()).toBe('2026-01-07T10:00:00.000Z');

    vi.useRealTimers();
  });

  it('creates all-day recurrences at local midnight when no time is specified', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-10T10:00:00.000Z'));

    const first = calculateFirstOccurrence({
      frequency: 'daily',
      timezone: 'UTC',
    });

    expect(first.toISOString()).toBe('2026-01-10T00:00:00.000Z');

    vi.useRealTimers();
  });

  describe('recurrence end conditions', () => {
    const due = new Date('2026-03-10T09:00:00.000Z');
    const daily = { frequency: 'daily' as const, hour: 9, minute: 0, timezone: 'UTC' };

    it('stops after a date-only end date in the rule timezone', () => {
      expect(calculateNextOccurrence(due, { ...daily, endDate: '2026-03-11' })?.toISOString()).toBe('2026-03-11T09:00:00.000Z');
      expect(calculateNextOccurrence(due, { ...daily, endDate: '2026-03-10' })).toBeNull();
    });

    it('compares a timestamped end date as an instant', () => {
      expect(calculateNextOccurrence(due, { ...daily, endDate: '2026-03-11T09:00:00Z' })?.toISOString()).toBe('2026-03-11T09:00:00.000Z');
      expect(calculateNextOccurrence(due, { ...daily, endDate: '2026-03-11T08:59:59Z' })).toBeNull();
    });

    it('stops when the completed count reaches the occurrence count', () => {
      expect(calculateNextOccurrence(due, { ...daily, count: 3 }, 1)?.toISOString()).toBe('2026-03-11T09:00:00.000Z');
      expect(calculateNextOccurrence(due, { ...daily, count: 3 }, 2)).toBeNull();
      expect(calculateNextOccurrence(due, { ...daily, count: 1 })).toBeNull();
    });
  });
});
