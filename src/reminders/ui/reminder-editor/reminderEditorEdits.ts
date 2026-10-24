import { findLinkMatches, findProjectMatches } from '../../core/grammar/richTextMatchers';
import { parseReminderContent } from '../../core/grammar/reminderParser';

/** DOM caret offsets count link labels; the draft includes their Markdown syntax. */
export function toReminderTextOffset(text: string, cursor: number): number {
    let offset = cursor;
    let hidden = 0;
    for (const link of findLinkMatches(text)) {
        const visibleEnd = link.index - hidden + (link.linkText?.length ?? 0);
        if (cursor < visibleEnd) break;
        const difference = link.length - (link.linkText?.length ?? 0);
        offset += difference;
        hidden += difference;
    }
    return offset;
}

export function toReminderCursorOffset(text: string, offset: number): number {
    return findLinkMatches(text).reduce((cursor, link) =>
        link.index + link.length <= offset ? cursor - link.length + (link.linkText?.length ?? 0) : cursor, offset);
}

/** Caret after the user's own words. Chip edits rebuild the text with metadata after them. */
export function getReminderTitleCaret(text: string, knownProjects?: string[]): number {
    const words = (parseReminderContent(text, knownProjects).cleanContent ?? text).trim();
    return toReminderCursorOffset(text, text.startsWith(words) ? words.length : text.length);
}

/** Replace the current project token, including its suffix beyond the caret. */
export function replaceReminderProject(text: string, start: number, length: number, project: string, knownProjects?: string[]) {
    const current = findProjectMatches(text, knownProjects).find(match => match.index === start);
    const end = Math.max(start + length, current ? current.index + current.length : start);
    const after = text.slice(end);
    const replacement = `#${project}${/^[ \t\u00a0]/.test(after) ? '' : ' '}`;
    const inserted = text.slice(0, start) + replacement + after;
    return { text: inserted, cursor: start + project.length + 2 };
}
