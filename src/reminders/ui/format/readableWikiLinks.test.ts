import { describe, expect, it } from 'vitest';
import { readableWikiLinks } from './readableWikiLinks';

describe('readable wiki links', () => {
  it('displays note names, aliases, and headings within reminder text', () => {
    expect(readableWikiLinks('Update [[Notes/Feature tours/Reminder feature.md]]')).toBe('Update Reminder feature');
    expect(readableWikiLinks('Read [[Notes/Plan|the plan]] and [[Notes/Plan#Next steps]]')).toBe('Read the plan and Plan › Next steps');
  });
  it('preserves ordinary text and incomplete links during editing', () => {
    expect(readableWikiLinks('Update [[Notes/Plan')).toBe('Update [[Notes/Plan');
    expect(readableWikiLinks('Call Alex')).toBe('Call Alex');
  });
});
