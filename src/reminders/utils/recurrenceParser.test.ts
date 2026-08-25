import { getLocalTimeZone } from '@internationalized/date';
import { describe, expect, it } from 'vitest';
import { parseRecurrenceFromContent } from './recurrenceParser';
import { recurrenceToText } from './rruleConverter';

describe('parseRecurrenceFromContent', () => {
  it('parses daily recurrence with time and timezone', () => {
    const result = parseRecurrenceFromContent('review inbox daily 15:00');

    expect(result?.matched).toBe('daily 15:00');
    expect(result?.rule).toMatchObject({
      frequency: 'daily',
      hour: 15,
      minute: 0,
      timezone: getLocalTimeZone(),
    });
  });

  it('parses interval recurrence', () => {
    const result = parseRecurrenceFromContent('backup every 2 weeks 09:30');

    expect(result?.matched).toBe('every 2 weeks 09:30');
    expect(result?.rule).toMatchObject({
      frequency: 'weekly',
      interval: 2,
      hour: 9,
      minute: 30,
    });
  });

  it('parses monthly recurrence with ordinal day', () => {
    const result = parseRecurrenceFromContent('pay rent monthly on the 1st');

    expect(result?.matched).toBe('monthly on the 1st');
    expect(result?.rule).toMatchObject({
      frequency: 'monthly',
      dayOfMonth: 1,
    });
  });

  it('parses and sorts multiple weekdays', () => {
    const result = parseRecurrenceFromContent('standup every Fri, Mon and Wed 10:00');

    expect(result?.matched).toBe('every Fri, Mon and Wed 10:00');
    expect(result?.rule).toMatchObject({
      frequency: 'weekly',
      daysOfWeek: [1, 3, 5],
      hour: 10,
      minute: 0,
    });
  });

  it('round trips a weekly interval with selected days', () => {
    const text = recurrenceToText({
      frequency: 'weekly',
      interval: 2,
      daysOfWeek: [1, 3],
      hour: 9,
      minute: 0,
    });
    const result = parseRecurrenceFromContent(text);

    expect(text).toBe('every 2 weeks on Mon, Wed 09:00');
    expect(result?.matched).toBe(text);
    expect(result?.rule).toMatchObject({
      frequency: 'weekly',
      interval: 2,
      daysOfWeek: [1, 3],
      hour: 9,
      minute: 0,
    });
  });

  it('round trips a monthly interval with its month day', () => {
    const text = recurrenceToText({
      frequency: 'monthly',
      interval: 2,
      dayOfMonth: 15,
      hour: 9,
      minute: 0,
    });
    const result = parseRecurrenceFromContent(text);

    expect(text).toBe('every 2 months on the 15th 09:00');
    expect(result?.matched).toBe(text);
    expect(result?.rule).toMatchObject({
      frequency: 'monthly',
      interval: 2,
      dayOfMonth: 15,
      hour: 9,
      minute: 0,
    });
  });

  it('returns null when no recurrence pattern is present', () => {
    expect(parseRecurrenceFromContent('review next monday')).toBeNull();
  });
});
