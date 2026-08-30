import { describe, it, expect } from 'vitest';
import { normalizeReminderIds } from '@/reminders/data/vaultScanner';

describe('reminder ID normalization', () => {
  it('adds fresh reminder identifiers to plain markdown reminder lines', async () => {
    const result = normalizeReminderIds('- [ ] Task A\n- [ ] Task A\n');

    expect(result.remindersUpdated).toBe(2);
    const migrated = result.content;
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

  it('preserves existing IDs and ignores empty checkboxes', () => {
    const content = '- [ ] Existing <!-- crate-id:r1 -->\n- [ ] \nBody';
    expect(normalizeReminderIds(content)).toEqual({ content, remindersUpdated: 0 });
  });

  it('replaces pasted duplicate IDs while preserving the first occurrence', () => {
    const result = normalizeReminderIds([
      '- [ ] Original <!-- crate-id:r1 -->',
      '- [ ] Pasted <!-- crate-id:r1 -->',
      '- [ ] Reserved collision <!-- crate-id:r2 -->',
    ].join('\n'), new Set(['r2']));

    expect(result.remindersUpdated).toBe(2);
    const ids = [...result.content.matchAll(/crate-id:([^\s>]+)/g)].map((match) => match[1]);
    expect(ids[0]).toBe('r1');
    expect(new Set(ids).size).toBe(3);
    expect(ids).not.toContain('r2');
  });
});
