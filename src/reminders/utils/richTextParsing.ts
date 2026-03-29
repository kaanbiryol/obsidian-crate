import * as chrono from 'chrono-node';
import { getFontWeight } from '../ui/themes';
import { findStandalonePriorityMarkerIndexes } from './priorityMarker';

export interface TextMatch {
    text: string;
    index: number;
    length: number;
    type: 'priority' | 'date' | 'project';
}

/**
 * Escape HTML special characters
 */
export const escapeHTML = (str: string): string => {
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;')
        .replace(/\n/g, '<br>');
};

/**
 * Get chip styles for different types
 * Minimal, inline annotation style - subtle enough to not overpower text
 */
export const getChipStyle = (type: string, _text: string): string => {
    const fontWeight = getFontWeight('medium');
    const baseStyle = `
        padding: 1px 6px;
        border-radius: 6px;
        display: inline;
        font-size: inherit;
        font-weight: ${fontWeight};
        letter-spacing: 0.01em;
        margin: 0 1px;
        box-decoration-break: clone;
        -webkit-box-decoration-break: clone;
        vertical-align: baseline;
    `.replace(/\s+/g, ' ').trim();

    // Refined, understated chips - color only, very subtle background
    if (type === 'priority') {
        return baseStyle + `
            background: hsl(var(--heroui-danger) / 0.08);
            color: hsl(var(--heroui-danger));
        `.replace(/\s+/g, ' ').trim();
    } else if (type === 'date') {
        return baseStyle + `
            background: hsl(var(--heroui-success) / 0.08);
            color: hsl(var(--heroui-success));
        `.replace(/\s+/g, ' ').trim();
    } else if (type === 'project') {
        return baseStyle + `
            background: hsl(var(--heroui-primary) / 0.08);
            color: hsl(var(--heroui-primary));
        `.replace(/\s+/g, ' ').trim();
    }
    return baseStyle;
};

/**
 * Create HTML for a chip
 */
export const createChipHTML = (type: string, text: string): string => {
    const escapedText = escapeHTML(text);
    const style = getChipStyle(type, text);
    return `<span class="rich-text-chip" style="${style}">${escapedText}</span>`;
};

/**
 * Find all important marker matches in text (! with space before, or standalone)
 * Extensible for future p1-p4 support
 */
export const findPriorityMatches = (text: string): TextMatch[] => {
    return findStandalonePriorityMarkerIndexes(text).map(index => ({
        text: text[index] ?? '!',
        index,
        length: 1,
        type: 'priority'
    }));
};

/**
 * Find all project matches in text (#something)
 * - Skips purely numeric tags (like #338 in GitHub issue links)
 * - Skips tags inside markdown links [text](url)
 * - If knownProjects is provided, matches multi-word project names first
 */
export const findProjectMatches = (text: string, knownProjects?: string[]): TextMatch[] => {
    const matches: TextMatch[] = [];
    const coveredRanges: Array<{ start: number; end: number }> = [];

    // First, find all markdown link ranges to exclude
    const linkRanges: Array<{ start: number; end: number }> = [];
    const linkRegex = /\[([^\]]*)\]\([^)]*\)/g;
    let linkMatch;
    while ((linkMatch = linkRegex.exec(text)) !== null) {
        linkRanges.push({
            start: linkMatch.index,
            end: linkMatch.index + linkMatch[0].length
        });
    }

    // Helper to check if a position overlaps with already matched ranges
    const isRangeCovered = (start: number, length: number): boolean => {
        return coveredRanges.some(
            range => (start >= range.start && start < range.end) ||
                     (start + length > range.start && start + length <= range.end) ||
                     (start <= range.start && start + length >= range.end)
        );
    };

    // Try known projects first (sorted by length descending to match longest first)
    if (knownProjects && knownProjects.length > 0) {
        const sortedProjects = [...knownProjects].sort((a, b) => b.length - a.length);
        for (const knownProject of sortedProjects) {
            // Escape special regex characters in project name
            const escapedProject = knownProject.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            // Match #projectName followed by space, end of string, or another special char
            const projectRegex = new RegExp(`#${escapedProject}(?=\\s|$|@|!|#)`, 'gi');
            let match: RegExpExecArray | null;
            while ((match = projectRegex.exec(text)) !== null) {
                const matchIndex = match.index;
                const matchText = match[0];

                // Check if this match is inside a markdown link
                const isInsideLink = linkRanges.some(
                    range => matchIndex >= range.start && matchIndex < range.end
                );

                // Check if this range is already covered by a previous match
                if (!isInsideLink && !isRangeCovered(matchIndex, matchText.length)) {
                    matches.push({
                        text: matchText,
                        index: matchIndex,
                        length: matchText.length,
                        type: 'project'
                    });
                    coveredRanges.push({
                        start: matchIndex,
                        end: matchIndex + matchText.length
                    });
                }
            }
        }
    }

    // Fallback to single-word regex (excluding already matched ranges)
    // Find project tags that:
    // 1. Start with # followed by at least one letter (not purely numeric)
    // 2. Can contain letters, numbers, underscores, hyphens, slashes (for nested tags)
    // e.g., #work, #Project/Reminders, #work/meetings
    const projectMatches = [...text.matchAll(/#([a-zA-Z][a-zA-Z0-9_/-]*)/g)];
    projectMatches.forEach(match => {
        if (match.index !== undefined) {
            const matchIndex = match.index;
            // Check if this match is inside a markdown link
            const isInsideLink = linkRanges.some(
                range => matchIndex >= range.start && matchIndex < range.end
            );

            // Check if this range is already covered by a known project match
            if (!isInsideLink && !isRangeCovered(matchIndex, match[0].length)) {
                matches.push({
                    text: match[0],
                    index: matchIndex,
                    length: match[0].length,
                    type: 'project'
                });
                coveredRanges.push({
                    start: matchIndex,
                    end: matchIndex + match[0].length
                });
            }
        }
    });
    return matches;
};

/**
 * Recurrence prefix patterns that should be highlighted along with the date
 * These patterns match text like "every", "daily", "weekly", "every 2 weeks", etc.
 */
const RECURRENCE_PREFIX_PATTERNS = [
    // "every day", "every week", "every month", "every year"
    /every\s+(?:\d+\s+)?(?:day|week|month|year)s?\s+/i,
    // "every Fri, ", "every Mon, Wed, " (weekday patterns before dates)
    /every\s+(?:(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|wed|thu|fri|sat|sun)(?:\s*,\s*)?)+\s*/i,
    // "every Monday", "every Mon and Wed", "every weekday"
    /every\s+/i,
    // "monthly on the 1st ", "monthly on 15th " (monthly with day ordinal before time)
    /monthly(?:\s+on\s+(?:the\s+)?\d{1,2}(?:st|nd|rd|th))?\s+/i,
    // "daily", "weekly", "yearly"
    /(?:daily|weekly|yearly)\s+/i,
];

/**
 * Standalone recurrence patterns (when no chrono date follows)
 * e.g., "every day", "daily", "weekly", "every 2 weeks", "monthly on the 15th"
 */
const STANDALONE_RECURRENCE_PATTERNS = [
    // "every day", "every week", "every month", "every year", "every 2 weeks" with optional time
    /every\s+(?:\d+\s+)?(?:day|week|month|year)s?(?:\s+\d{1,2}:\d{2})?(?:\s|$)/gi,
    // "monthly on the 14th", "monthly on 15th", etc. with optional time
    /monthly(?:\s+on\s+(?:the\s+)?\d{1,2}(?:st|nd|rd|th)?)?(?:\s+\d{1,2}:\d{2})?(?:\s|$)/gi,
    // "daily", "weekly", "yearly" with optional time (monthly handled above with optional suffix)
    /(?:daily|weekly|yearly)(?:\s+\d{1,2}:\d{2})?(?:\s|$)/gi,
    // "every Monday", "every Mon, Wed, Fri" (specific weekdays) with optional time
    /every\s+(?:(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|wed|thu|fri|sat|sun)(?:\s*,\s*)?)+(?:\s+\d{1,2}:\d{2})?(?:\s|$)/gi,
];

/**
 * Find standalone recurrence matches (not followed by a chrono date)
 */
export const findRecurrenceMatches = (text: string, chronoMatches: TextMatch[]): TextMatch[] => {
    const matches: TextMatch[] = [];

    for (const pattern of STANDALONE_RECURRENCE_PATTERNS) {
        // Reset regex state
        pattern.lastIndex = 0;
        let match;
        while ((match = pattern.exec(text)) !== null) {
            const matchText = match[0].trimEnd();
            const index = match.index;

            // Check if this position overlaps with any chrono match
            const overlapsWithChrono = chronoMatches.some(cm =>
                (index >= cm.index && index < cm.index + cm.length) ||
                (cm.index >= index && cm.index < index + matchText.length)
            );

            if (!overlapsWithChrono) {
                matches.push({
                    text: matchText,
                    index: index,
                    length: matchText.length,
                    type: 'date'
                });
            }
        }
    }

    return matches;
};

/**
 * Find all date matches in text using chrono
 * Also extends matches to include recurrence prefixes like "every"
 */
export const findDateMatches = (text: string): TextMatch[] => {
    const matches: TextMatch[] = [];
    const chronoResults = chrono.parse(text);
    let lastSearchIndex = 0;

    chronoResults.forEach((result) => {
        if (result.start && result.text) {
            const matchedText = result.text;
            let index = text.indexOf(matchedText, lastSearchIndex);

            if (index !== -1) {
                // Check if there's a recurrence prefix before this match
                let extendedIndex = index;
                let extendedText = matchedText;

                // Look for recurrence prefixes before the chrono match
                const textBefore = text.substring(0, index);

                for (const pattern of RECURRENCE_PREFIX_PATTERNS) {
                    // Check if the text before ends with a recurrence pattern
                    const prefixMatch = textBefore.match(new RegExp(pattern.source + '$', 'i'));
                    if (prefixMatch) {
                        const prefix = prefixMatch[0];
                        extendedIndex = index - prefix.length;
                        extendedText = prefix + matchedText;
                        break;
                    }
                }

                // Check if this extended match overlaps with a previous match
                // This happens when chrono parses "every Fri, Sat 09:00" as two separate results
                // We want to merge them into a single match
                const lastMatch = matches[matches.length - 1];
                if (lastMatch && extendedIndex <= lastMatch.index + lastMatch.length) {
                    // This match overlaps with or is adjacent to the previous one
                    // Extend the previous match to include this one
                    const newEnd = index + matchedText.length;
                    lastMatch.text = text.substring(lastMatch.index, newEnd);
                    lastMatch.length = newEnd - lastMatch.index;
                } else {
                    matches.push({
                        text: extendedText,
                        index: extendedIndex,
                        length: extendedText.length,
                        type: 'date'
                    });
                }
                lastSearchIndex = index + matchedText.length;
            }
        }
    });

    // Also find standalone recurrence patterns not captured by chrono
    const standaloneRecurrenceMatches = findRecurrenceMatches(text, matches);
    matches.push(...standaloneRecurrenceMatches);

    return matches;
};

/**
 * Find all matches (priorities, projects, dates) in text
 * @param text The text to search
 * @param knownProjects Optional array of known project names for multi-word matching
 */
export const findAllMatches = (text: string, knownProjects?: string[]): TextMatch[] => {
    const allMatches = [
        ...findPriorityMatches(text),
        ...findProjectMatches(text, knownProjects),
        ...findDateMatches(text)
    ];

    // Sort by position and remove overlapping matches
    allMatches.sort((a, b) => a.index - b.index);

    const nonOverlappingMatches: TextMatch[] = [];
    allMatches.forEach(match => {
        const overlaps = nonOverlappingMatches.some(existing =>
            (match.index >= existing.index && match.index < existing.index + existing.length) ||
            (existing.index >= match.index && existing.index < match.index + match.length)
        );
        if (!overlaps) {
            nonOverlappingMatches.push(match);
        }
    });

    return nonOverlappingMatches;
};

/**
 * Build HTML with chips from plain text
 * @param text The text to render
 * @param knownProjects Optional array of known project names for multi-word matching
 */
export const buildHTML = (text: string, knownProjects?: string[]): string => {
    if (!text) return '';

    const parts: string[] = [];
    let lastIndex = 0;
    const matches = findAllMatches(text, knownProjects);

    // Build HTML parts
    matches.forEach((match) => {
        // Add text before match
        if (match.index > lastIndex) {
            const beforeText = text.slice(lastIndex, match.index);
            parts.push(escapeHTML(beforeText));
        }

        // Add chip span
        const chipHTML = createChipHTML(match.type, match.text);
        parts.push(chipHTML);

        lastIndex = match.index + match.length;
    });

    // Add remaining text
    if (lastIndex < text.length) {
        parts.push(escapeHTML(text.slice(lastIndex)));
    }

    return parts.join('');
};

/**
 * Extract plain text from a contenteditable element
 */
export const getPlainText = (element: HTMLElement | null): string => {
    if (!element) return '';

    let text = '';
    const walk = (node: Node) => {
        if (node.nodeType === Node.TEXT_NODE) {
            text += node.textContent || '';
        } else if (node.nodeName === 'BR') {
            text += '\n';
        } else if (node.childNodes) {
            node.childNodes.forEach(walk);
        }
    };
    walk(element);
    return text;
};
