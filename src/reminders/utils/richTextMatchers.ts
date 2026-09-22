import { parseMarkdownLinks, isSafeUrl } from './markdownLinks';
import { findStandalonePriorityMarkerIndexes } from './priorityMarker';
import type { TextMatch } from './richTextTypes';
import { findReminderScheduleMatches } from './reminderSchedule';

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
    const linkRanges = parseMarkdownLinks(text).map(link => ({
        start: link.index,
        end: link.index + link.fullMatch.length
    }));

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
            const projectRegex = new RegExp(`(?<!\\S)#${escapedProject}(?=\\s|$|@|!|#)`, 'gi');
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
    // 1. Start at a token boundary with # and a Unicode letter (not purely numeric)
    // 2. Include combining accents, numbers, underscores, hyphens and nested paths
    // e.g., #work, #Project/Reminders, #work/meetings
    const projectMatches = [...text.matchAll(/(?<!\S)#(\p{L}[\p{L}\p{M}\p{N}_/-]*)/gu)];
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
 * Find all markdown link matches in text
 */
export const findLinkMatches = (text: string): TextMatch[] => {
    return parseMarkdownLinks(text)
        .filter(link => link.text.length > 0 && isSafeUrl(link.url))
        .map(link => ({
            text: link.fullMatch,
            index: link.index,
            length: link.fullMatch.length,
            type: 'link' as const,
            linkText: link.text,
            linkUrl: link.url,
        }));
};

/**
 * Find all matches (links, priorities, projects, dates) in text
 * Links are matched first so their contents don't get misidentified as other types.
 * @param text The text to search
 * @param knownProjects Optional array of known project names for multi-word matching
 */
export const findAllMatches = (text: string, knownProjects?: string[], referenceDate = new Date()): TextMatch[] => {
    const projects = findProjectMatches(text, knownProjects);
    let dateText = text;
    // Keep offsets without letting date parsing bridge a protected marker:
    // spaces would turn "12:00 #Home p" into a single PM time match.
    for (const project of projects) {
        dateText = dateText.slice(0, project.index) + '\uFFFC'.repeat(project.length) + dateText.slice(project.index + project.length);
    }
    const allMatches = [
        ...findLinkMatches(text),
        ...findPriorityMatches(text),
        ...projects,
        ...findReminderScheduleMatches(dateText, referenceDate)
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
