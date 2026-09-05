import { findAllMatches, findLinkMatches } from './richTextMatchers';
import { findActiveReminderMatches } from './reminderEditorParsing';
import { parseRecurrenceFromContent } from './recurrenceParser';
import type { TextMatch } from './richTextTypes';

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

function removeMatches(text: string, cursor: number, matches: TextMatch[]) {
    let nextCursor = cursor;
    for (const match of [...matches].sort((a, b) => b.index - a.index)) {
        // Contenteditable inserts NBSPs around chips. Normalize only the gap
        // joined by this deletion; leave other spacing and line breaks alone.
        let start = match.index;
        let end = match.index + match.length;
        while (start > 0 && /[ \t\u00a0]/.test(text[start - 1]!)) start--;
        while (end < text.length && /[ \t\u00a0]/.test(text[end]!)) end++;
        const atLineStart = start === 0 || /[\r\n]/.test(text[start - 1]!);
        const hasFollowingText = end < text.length && !/[\r\n]/.test(text[end]!);
        const hadSpacing = start < match.index || end > match.index + match.length;
        const separator = atLineStart
            ? (hasFollowingText ? text.slice(start, match.index) : '')
            : hadSpacing && (hasFollowingText || (end === text.length && end > match.index + match.length)) ? ' ' : '';
        text = text.slice(0, start) + separator + text.slice(end);
        if (nextCursor >= end) nextCursor -= end - start - separator.length;
        else if (nextCursor > start) nextCursor = start + separator.length;
    }
    return { text, cursor: nextCursor };
}

/** Commit explicit markers only at a boundary, never while a name is being typed. */
export function commitReminderMarkers(text: string, cursor: number, projects?: string[], paste = false, previousText?: string) {
    const matches = findAllMatches(text, projects);
    const removed: TextMatch[] = [];
    for (const type of ['project', 'priority'] as const) {
        const candidates = matches.filter(match => match.type === type);
        const selected = paste ? candidates.at(-1) : candidates.find(match =>
            match.index + match.length < cursor && /^\s+$/.test(text.slice(match.index + match.length, cursor)));
        if (!paste && type === 'project' && selected) {
            const name = selected.text.slice(1).toLowerCase();
            if (!projects?.some(project => project.toLowerCase() === name)
                && projects?.some(project => project.toLowerCase().startsWith(`${name} `))) continue;
        }
        if (selected) removed.push(...candidates.filter(match => match !== selected));
    }
    // A newly completed schedule replaces the previously active schedule. Other
    // date mentions in pasted prose remain text rather than being deleted.
    const schedule = matches.find(match => match.type === 'date'
        && match.index + match.length < cursor
        && /^\s+$/.test(text.slice(match.index + match.length, cursor)));
    const committedSchedule = paste ? matches.filter(match => match.type === 'date').at(-1) : schedule;
    if (committedSchedule) {
        removed.push(...matches.filter(match => match.type === 'date' && match !== committedSchedule
            && (parseRecurrenceFromContent(match.text) || match.text.toLowerCase() === committedSchedule.text.toLowerCase())));
    }
    if (!paste && schedule && previousText !== undefined) {
        const previous = findActiveReminderMatches(previousText, projects).find(match => match.type === 'date');
        if (previous) {
            let prefix = 0;
            while (prefix < previousText.length && prefix < text.length && previousText[prefix] === text[prefix]) prefix++;
            let suffix = 0;
            while (suffix < previousText.length - prefix && suffix < text.length - prefix
                && previousText[previousText.length - 1 - suffix] === text[text.length - 1 - suffix]) suffix++;
            const oldIndex = previous.index + previous.length <= prefix ? previous.index
                : previous.index >= previousText.length - suffix ? previous.index + text.length - previousText.length : -1;
            const oldMatch = matches.find(match => match.type === 'date' && match.index === oldIndex);
            if (oldMatch && oldMatch !== schedule) removed.push(oldMatch);
        }
    }
    return removeMatches(text, cursor, [...new Set(removed)]);
}

/** Autocomplete replaces every earlier project, including a query in the middle. */
export function replaceReminderProject(text: string, start: number, length: number, project: string, projects: string[]) {
    const replacement = `#${project} `;
    const after = text.slice(start + length).replace(/^[ \t\u00a0]+/, '');
    const inserted = text.slice(0, start) + replacement + after;
    const others = findAllMatches(inserted, [...projects, project]).filter(match =>
        match.type === 'project' && match.index !== start);
    return removeMatches(inserted, start + replacement.length, others);
}
