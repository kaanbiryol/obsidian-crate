import { findAllMatches } from './richTextMatchers';
import { parseReminderContent, type ParsedReminder } from './reminderParser';
import type { TextMatch } from './richTextTypes';

/** The last value wins, so metadata appended by a picker stays authoritative. */
export function findActiveReminderMatches(text: string, projects?: string[]): TextMatch[] {
    return selectActiveMatches(findAllMatches(text, projects)).filter(match => !match.invalid);
}

function selectActiveMatches(matches: TextMatch[]): TextMatch[] {
    const lastIndex = new Map<TextMatch['type'], number>();
    matches.forEach((match, index) => lastIndex.set(match.type, index));
    return matches.filter((match, index) => match.type === 'link' || lastIndex.get(match.type) === index);
}

/** Share the editor's active chips with draft state and both submission paths. */
export function parseReminderEditorContent(text: string, projects?: string[]): ParsedReminder {
    return parseReminderContent(text, projects);
}
