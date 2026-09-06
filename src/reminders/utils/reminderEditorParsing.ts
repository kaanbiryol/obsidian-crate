import { findAllMatches } from './richTextMatchers';
import { parseReminderContent, type ParsedReminder } from './reminderParser';
import { parseRecurrenceFromContent } from './recurrenceParser';
import type { TextMatch } from './richTextTypes';

/** The last value wins, so metadata appended by a picker stays authoritative. */
export function findActiveReminderMatches(text: string, projects?: string[]): TextMatch[] {
    return selectActiveMatches(findAllMatches(text, projects));
}

function selectActiveMatches(matches: TextMatch[]): TextMatch[] {
    const lastIndex = new Map<TextMatch['type'], number>();
    matches.forEach((match, index) => lastIndex.set(match.type, index));
    return matches.filter((match, index) => match.type === 'link' || lastIndex.get(match.type) === index);
}

/** Share the editor's active chips with draft state and both submission paths. */
export function parseReminderEditorContent(text: string, projects?: string[]): ParsedReminder {
    const matches = findAllMatches(text, projects);
    const active = selectActiveMatches(matches);
    const schedule = active.find(match => match.type === 'date');
    const project = active.find(match => match.type === 'project')?.text.slice(1);
    const priority = active.some(match => match.type === 'priority');
    const parsed: ParsedReminder = schedule ? parseReminderContent(schedule.text) : { cleanContent: '', priority: 4 as const };
    // Extra date mentions are prose. Explicit project/priority markers and repeat
    // rules are metadata, so obsolete copies should not leak into the saved title.
    const removed = matches.filter(match =>
        match.type === 'project' || match.type === 'priority'
        || (match.type === 'date' && (match.index === schedule?.index || parseRecurrenceFromContent(match.text))));
    let cleanContent = text;
    for (const match of removed.reverse()) {
        cleanContent = cleanContent.slice(0, match.index) + cleanContent.slice(match.index + match.length);
    }
    return {
        ...parsed,
        dueDate: parsed.recurrence ? undefined : parsed.dueDate,
        hasTime: parsed.recurrence ? undefined : parsed.hasTime,
        cleanContent: cleanContent.replace(/\s+/g, ' ').trim(),
        project: projects?.find(name => name.toLowerCase() === project?.toLowerCase()) ?? project,
        priority: priority ? 1 : 4,
        priorityPart: priority ? '!' : undefined,
    };
}
