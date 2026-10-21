import { describe, expect, it } from 'vitest';
import { replaceReminderProject, toReminderCursorOffset, toReminderTextOffset } from './reminderEditorEdits';

describe('reminder editor token edits', () => {
    it.each([
        ['Task #Wrk tail #Home', 'Task #Work tail #Home'],
        ['Task #Wörk tail', 'Task #Work tail'],
        ['Task #Work/meetings tail', 'Task #Work tail'],
        ['Task #Wrk', 'Task #Work '],
    ])('replaces the suffix beyond the caret without changing other tokens: %s', (text, expected) => {
        expect(replaceReminderProject(text, 5, 2, 'Work')).toEqual({ text: expected, cursor: 11 });
    });

    it('replaces an entire known multiword project at the caret', () => {
        expect(replaceReminderProject('Task #Crate Demo then #Work', 5, 3, 'Home', ['Crate Demo', 'Work']))
            .toEqual({ text: 'Task #Home then #Work', cursor: 11 });
    });

    it('replaces only the query when autocomplete is selected in the middle', () => {
        expect(replaceReminderProject('Task #ho then #Work', 5, 3, 'Home')).toEqual({
            text: 'Task #Home then #Work', cursor: 11,
        });
    });

    it('preserves links and caret offsets when replacing projects after a link', () => {
        const text = '[docs](https://example.com) #Work #ho';
        const cursor = toReminderTextOffset(text, 'docs #Work #ho'.length);
        expect(cursor).toBe(text.length);
        const next = replaceReminderProject(text, cursor - 3, 3, 'Home');
        expect(next.text).toBe('[docs](https://example.com) #Work #Home ');
        expect(toReminderCursorOffset(next.text, next.cursor)).toBe('docs #Work #Home '.length);
    });

});

it('preserves spacing and other project mentions outside the completed query', () => {
    expect(replaceReminderProject('Compare #Work with #ho  carefully', 19, 3, 'Home')).toEqual({
        text: 'Compare #Work with #Home  carefully', cursor: 25,
    });
});
