import { describe, expect, it } from 'vitest';
import { findAllMatches } from './richTextMatchers';
import { buildRichTextSegments } from './richTextRenderer';
import { parseReminderEditorContent } from './reminderEditorParsing';
import { commitReminderMarkers } from './reminderEditorEdits';

const projects = ['Home', 'Home Office', 'Tomorrow', 'Every Monday'];
const markers = ['#Home', '#Home Office', '#Tomorrow', '#Every Monday',
    '[notes](https://example.com)', 'https://example.com/path#Home', '!'];
const schedules = ['tomorrow 12:00', 'Monday at 9:00', 'every Monday 09:00', '2026-09-20T12:00:00Z'];

describe('reminder marker boundaries', () => {
    it.each(markers)('preserves source text and marker boundaries around %s', marker => {
        for (const schedule of schedules) {
            for (const suffix of ['p', 'pm', 'a', 'am', 'at noon', 'to 14:00', 'Friday', 'daily', 'pizza']) {
                const text = `${schedule} ${marker} ${suffix}`;
                for (const match of findAllMatches(text, projects)) {
                    expect(match.text, text).toBe(text.slice(match.index, match.index + match.length));
                    if (match.type === 'date') expect(match.text, text).not.toContain(marker);
                }
                const reconstructed = buildRichTextSegments(text, projects)
                    .map(segment => segment.kind === 'link' ? segment.source : segment.text).join('');
                expect(reconstructed, text).toBe(text);
                const parsed = parseReminderEditorContent(text, projects);
                if (marker.startsWith('#')) expect(parsed.project, text).toBe(marker.slice(1));
                else if (marker === '!') expect(parsed.priority, text).toBe(1);
                else expect(parsed.cleanContent, text).toContain(marker);
            }
        }
    });

    it.each(projects)('keeps %s through incremental typing and committing a word', project => {
        let previous = `tomorrow 12:00 #${project} `;
        for (const letter of 'pizza ') {
            const text = previous + letter;
            const next = commitReminderMarkers(text, text.length, projects, false, previous);
            expect(next).toEqual({ text, cursor: text.length });
            expect(parseReminderEditorContent(next.text, projects).project).toBe(project);
            previous = next.text;
        }
    });
});
