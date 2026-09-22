import { describe, expect, it, vi } from 'vitest';
import * as matchers from './richTextMatchers';
import { buildRichTextSegments } from './richTextRenderer';
import { parseReminderEditorContent } from './reminderEditorParsing';
import { parseCheckboxLine, rebuildCheckboxLine } from './checkboxParser';

describe('reminder editor metadata', () => {
    it.each([
        ['Compare Monday with Friday', 'Compare Monday with', 'Friday'],
        ['Review weekly report tomorrow', 'Review weekly report', 'tomorrow'],
        ['Task every Monday Friday', 'Task every Monday', 'Friday'],
        ['Task Tuesday Tuesday', 'Task Tuesday', 'Tuesday'],
    ])('keeps earlier schedule text when the last schedule wins: %s', (text, cleanContent, datePart) => {
        expect(parseReminderEditorContent(text)).toMatchObject({ cleanContent, datePart, recurrence: undefined });
        expect(buildRichTextSegments(text).filter(segment => segment.kind === 'chip')).toEqual([
            { kind: 'chip', type: 'date', text: datePart },
        ]);
    });

    it.each(['2026-02-30', '2026-02-29 09:00', 'February 30 at 9 in the morning'])('keeps the earlier Chrono date when later text has no match: %s', date => {
        const text = `Task tomorrow ${date}`;
        expect(parseReminderEditorContent(text)).toMatchObject({
            cleanContent: `Task ${date}`, datePart: 'tomorrow', dateError: undefined,
        });
        expect(buildRichTextSegments(text)).toEqual([
            { kind: 'text', text: 'Task ' }, { kind: 'chip', type: 'date', text: 'tomorrow' }, { kind: 'text', text: ` ${date}` },
        ]);
    });

    it.each(['Café', 'Cafe\u0301', '日本語'])('keeps the full project name and removes no title letters: %s', project => {
        expect(parseReminderEditorContent(`Task #${project}`)).toMatchObject({ cleanContent: 'Task', project });
        expect(buildRichTextSegments(`Task #${project}`)).toEqual([
            { kind: 'text', text: 'Task ' }, { kind: 'chip', type: 'project', text: `#${project}` },
        ]);
    });

    it.each(['p', 'pm', 'a', 'am', 'pizza'])('preserves a project between a time and typed text: %s', suffix => {
        const text = `tomorrow 12:00 #Home ${suffix}`;
        expect(buildRichTextSegments(text, ['Home'])).toEqual([
            { kind: 'chip', type: 'date', text: 'tomorrow 12:00' },
            { kind: 'text', text: ' ' },
            { kind: 'chip', type: 'project', text: '#Home' },
            { kind: 'text', text: ` ${suffix}` },
        ]);
        expect(parseReminderEditorContent(text, ['Home'])).toMatchObject({
            cleanContent: suffix, project: 'Home', hasTime: true,
        });
    });

    it('does not extend a time across a Markdown link', () => {
        expect(parseReminderEditorContent('tomorrow 12:00 [notes](https://example.com) p')).toMatchObject({
            cleanContent: '[notes](https://example.com) p', hasTime: true,
        });
    });

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
            cleanContent: 'Task #Personal/Health #pomla Tuesday weekly !', project: 'Personal/Health', priority: 1,
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
        'every week Monday 09:00',
        'every Monday at noon',
        'daily at midnight',
        'weekly on Monday at 09:00',
        'every 2 weeks Monday, Wednesday, and Friday 09:00',
        'daily at 9pm',
        'monthly on the 15th at 09:00',
        'every Monday and Wednesday 09:00',
        'every 2 weeks on Mon, Wed 09:00',
        'every 2 months on the 15th 09:00',
        '2026-04-03 15:30',
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

it('consumes only the final project and priority markers', () => {
    expect(parseReminderEditorContent('Compare #Home with #Work ! !')).toMatchObject({
        cleanContent: 'Compare #Home with !', project: 'Work', priority: 1,
    });
});
