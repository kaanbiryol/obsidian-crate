import { describe, expect, it } from 'vitest';
import type { Reminder } from '../../types/reminder';
import { reconcileReminderOrder } from './useReminderOrder';

const reminder = (id: string, content = id): Reminder => ({
  id, content, completed: false, priority: 4,
});

describe('reconcileReminderOrder', () => {
  it('keeps the dropped order with fresh card data while persistence is pending', () => {
    const updated = reminder('a', 'Edited during the save');
    const result = reconcileReminderOrder([updated, reminder('b')], ['b', 'a']);
    expect(result.map((item) => item.id)).toEqual(['b', 'a']);
    expect(result[1]).toBe(updated);
  });

  it('removes completed or deleted cards immediately and includes new cards', () => {
    expect(reconcileReminderOrder([reminder('b'), reminder('new')], ['b', 'a'])
      .map((item) => item.id)).toEqual(['b', 'new']);
  });

  it('does not duplicate cards when an order contains repeated or missing ids', () => {
    expect(reconcileReminderOrder([reminder('a'), reminder('b')], ['b', 'b', 'gone'])
      .map((item) => item.id)).toEqual(['b', 'a']);
  });
});
