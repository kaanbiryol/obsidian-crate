import { findLinkMatches } from './richTextMatchers';
import { findActiveReminderMatches } from './reminderEditorParsing';

export type RichTextSegment =
    | { kind: 'text'; text: string }
    | { kind: 'chip'; text: string; type: 'priority' | 'date' | 'project' }
    | { kind: 'link'; text: string; url: string; source: string };

export const buildRichTextSegments = (text: string, knownProjects?: string[], markers = true): RichTextSegment[] => {
    if (!text) return [];

    const segments: RichTextSegment[] = [];
    let lastIndex = 0;

    for (const match of (markers ? findActiveReminderMatches(text, knownProjects) : findLinkMatches(text))) {
        if (match.index > lastIndex) {
            segments.push({ kind: 'text', text: text.slice(lastIndex, match.index) });
        }

        if (match.type === 'link' && match.linkText !== undefined && match.linkUrl !== undefined) {
            segments.push({ kind: 'link', text: match.linkText, url: match.linkUrl, source: match.text });
        } else if (match.type !== 'link') {
            segments.push({ kind: 'chip', text: match.text, type: match.type });
        }

        lastIndex = match.index + match.length;
    }

    if (lastIndex < text.length) {
        segments.push({ kind: 'text', text: text.slice(lastIndex) });
    }

    return segments;
};
