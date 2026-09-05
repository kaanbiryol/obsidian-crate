import { describe, expect, it } from 'vitest';
import { commitReminderMarkers, replaceReminderProject, toReminderCursorOffset, toReminderTextOffset } from './reminderEditorEdits';
import { RichTextInputHistory } from '../components/richTextInputHistory';

describe('reminder editor token edits', () => {
    it('waits for a boundary before replacing a typed project', () => {
        const partial = 'Task #Work #Pers';
        expect(commitReminderMarkers(partial, partial.length).text).toBe(partial);
        const complete = 'Task #Work #Personal ';
        expect(commitReminderMarkers(complete, complete.length)).toEqual({ text: 'Task #Personal ', cursor: 15 });
    });

    it('waits for the rest of a known multi-word project name', () => {
        const partial = 'Task #Work #Crate ';
        expect(commitReminderMarkers(partial, partial.length, ['Work', 'Crate Demo']).text).toBe(partial);
        const complete = `${partial}Demo `;
        expect(commitReminderMarkers(complete, complete.length, ['Work', 'Crate Demo']).text).toBe('Task #Crate Demo ');
    });

    it('deduplicates pasted projects and flags, preserving date mentions', () => {
        const text = 'Task #Work #Home ! ! Tuesday Friday';
        expect(commitReminderMarkers(text, text.length, [], true).text).toBe('Task #Home ! Tuesday Friday');
    });

    it('removes obsolete recurrence rules and identical dates from pasted text', () => {
        const repeated = 'Task Tuesday weekly every week';
        expect(commitReminderMarkers(repeated, repeated.length, [], true).text).toBe('Task Tuesday every week');
        const dates = 'Task Tuesday Tuesday';
        expect(commitReminderMarkers(dates, dates.length, [], true).text).toBe('Task Tuesday');
    });

    it('replaces a schedule only after the new expression is completed', () => {
        const previous = 'Task Tuesday ';
        const partial = `${previous}Friday`;
        expect(commitReminderMarkers(partial, partial.length, [], false, previous).text).toBe(partial);
        const complete = `${partial} `;
        expect(commitReminderMarkers(complete, complete.length, [], false, previous).text).toBe('Task Friday ');
    });

    it.each([' ', '\u00a0', ' \u00a0'])('does not leave a gap when removing a date surrounded by %j', space => {
        const previous = `eat${space}Tuesday${space}`;
        const text = `${previous}eat${space}Thursday${space}`;
        const next = commitReminderMarkers(text, text.length, [], false, previous);
        expect(next).toEqual({ text: `eat eat${space}Thursday${space}`, cursor: `eat eat${space}Thursday${space}`.length });
    });

    it('does not accumulate spaces through repeated date replacements', () => {
        let previous = 'eat Tuesday\u00a0';
        for (const day of ['Wednesday', 'Thursday', 'Friday']) {
            const text = `${previous}eat ${day}\u00a0`;
            previous = commitReminderMarkers(text, text.length, [], false, previous).text;
        }
        expect(previous).toBe('eat eat eat eat Friday\u00a0');
    });

    it('preserves unrelated spacing and line breaks when removing a date', () => {
        const previous = 'Keep  this\n  eat\u00a0Tuesday\u00a0';
        const text = `${previous}eat Thursday\u00a0`;
        const next = commitReminderMarkers(text, text.length, [], false, previous);
        expect(next.text).toBe('Keep  this\n  eat eat Thursday\u00a0');
        expect(next.cursor).toBe(next.text.length);
    });

    it('keeps the caret before following prose when replacing a date in the middle', () => {
        const previous = 'Task Tuesday\u00a0tail';
        const text = 'Task Friday\u00a0Tuesday\u00a0tail';
        expect(commitReminderMarkers(text, 12, [], false, previous)).toEqual({
            text: 'Task Friday tail', cursor: 12,
        });
    });

    it.each([
        ['Task weekly ', 'Task weekly Tuesday ', 'Task Tuesday '],
        ['Task Tuesday ', 'Task Tuesday every week ', 'Task every week '],
        ['Task Tuesday ', 'Task Friday Tuesday ', 'Task Friday '],
    ])('replaces schedules across types or from the middle', (previous, text, expected) => {
        const cursor = text === 'Task Friday Tuesday ' ? 12 : text.length;
        expect(commitReminderMarkers(text, cursor, [], false, previous).text).toBe(expected);
    });

    it('replaces all projects when autocomplete is selected in the middle', () => {
        expect(replaceReminderProject('Task #ho then #Work', 5, 3, 'Home', ['Home', 'Work'])).toEqual({
            text: 'Task #Home then', cursor: 11,
        });
    });

    it('preserves links and caret offsets when replacing projects after a link', () => {
        const text = '[docs](https://example.com) #Work #ho';
        const cursor = toReminderTextOffset(text, 'docs #Work #ho'.length);
        expect(cursor).toBe(text.length);
        const next = replaceReminderProject(text, cursor - 3, 3, 'Home', ['Work', 'Home']);
        expect(next.text).toBe('[docs](https://example.com) #Home ');
        expect(toReminderCursorOffset(next.text, next.cursor)).toBe('docs #Home '.length);
    });

    it('records token replacement as an undoable edit', () => {
        const before = { value: 'Task #Work #Home', cursor: 16 };
        const history = new RichTextInputHistory(before);
        const next = commitReminderMarkers(`${before.value} `, before.value.length + 1);
        const after = { value: next.text, cursor: next.cursor };
        history.record(after);
        expect(history.undo(after)).toEqual(before);
        expect(history.redo(before)).toEqual(after);
    });
});
