import { describe, expect, it, vi } from 'vitest';
import * as matchers from './richTextMatchers';
import { buildRichTextSegments } from './richTextRenderer';
import { parseReminderEditorContent } from './reminderEditorParsing';
import { parseCheckboxLine, rebuildCheckboxLine } from './checkboxParser';

describe('reminder editor metadata', () => {
    it('scans the full title once when deriving metadata and cleaned content', () => {
        const scan = vi.spyOn(matchers, 'findAllMatches');
        try {
            expect(parseReminderEditorContent('Task #Work ! Friday')).toMatchObject({ cleanContent: 'Task', project: 'Work', priority: 1 });
            expect(scan.mock.calls.filter(([text]) => text === 'Task #Work ! Friday')).toHaveLength(1);
        } finally {
            scan.mockRestore();
        }
    });
    it('renders one chip per category and saves those same values', () => {
        const text = 'Task #Personal/Health #pomla Tuesday weekly #Personal/Health ! ! every week';
        const chips = buildRichTextSegments(text).filter(segment => segment.kind === 'chip');
        expect(chips).toEqual([
            { kind: 'chip', type: 'project', text: '#Personal/Health' },
            { kind: 'chip', type: 'priority', text: '!' },
            { kind: 'chip', type: 'date', text: 'every week' },
        ]);
        expect(parseReminderEditorContent(text)).toMatchObject({
            cleanContent: 'Task Tuesday', project: 'Personal/Health', priority: 1,
            recurrence: { frequency: 'weekly' }, dueDate: undefined,
        });
    });

    it('preserves earlier date mentions as prose and uses the last schedule', () => {
        const text = 'Compare Tuesday with Friday';
        expect(buildRichTextSegments(text)).toEqual([
            { kind: 'text', text: 'Compare Tuesday with ' },
            { kind: 'chip', type: 'date', text: 'Friday' },
        ]);
        expect(parseReminderEditorContent(text)).toMatchObject({ cleanContent: 'Compare Tuesday with', datePart: 'Friday' });
    });

    it.each([
        'every Monday and Wednesday 09:00',
        'every 2 weeks on Mon, Wed 09:00',
        'every 2 months on the 15th 09:00',
        '2026-04-03T15:30:00.000Z',
    ])('keeps a complete schedule in one chip: %s', schedule => {
        expect(buildRichTextSegments(`Task ${schedule}`)).toEqual([
            { kind: 'text', text: 'Task ' },
            { kind: 'chip', type: 'date', text: schedule },
        ]);
        expect(parseReminderEditorContent(`Task ${schedule}`).cleanContent).toBe('Task');
    });

    it('does not interpret dates in project names or links', () => {
        const text = 'Read [Monday !](https://example.com/2026-04-03) #Tomorrow';
        expect(parseReminderEditorContent(text, ['Tomorrow'])).toMatchObject({
            cleanContent: 'Read [Monday !](https://example.com/2026-04-03)',
            project: 'Tomorrow', priority: 4, dueDate: undefined,
        });
    });

    it('chooses projects by text position, retaining their canonical casing', () => {
        expect(parseReminderEditorContent('Task #Long Project #work', ['Long Project', 'Work']).project).toBe('Work');
    });

    it.each(['Tuesday', '2026-04-01'])('preserves date mentions through a vault save and reload: %s', mention => {
        const parsed = parseReminderEditorContent(`Compare ${mention} with 2026-04-03`);
        const line = rebuildCheckboxLine('', false, parsed.cleanContent, parsed.dueDate, 4);
        const reloaded = parseCheckboxLine(line)?.parsed;
        expect(reloaded?.cleanContent).toBe(`Compare ${mention} with`);
        expect(reloaded?.dueDate).toEqual(parsed.dueDate);
    });
});
