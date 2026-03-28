/**
 * Utilities for project search and autocomplete
 */

/**
 * Filter projects by case-insensitive substring match.
 * Prefix matches are sorted first, then substring matches.
 */
export function filterProjects(projects: string[], query: string): string[] {
    const q = query.trim().toLowerCase();
    if (!q) return projects;

    const prefix: string[] = [];
    const substring: string[] = [];

    for (const project of projects) {
        const lower = project.toLowerCase();
        if (lower.startsWith(q)) {
            prefix.push(project);
        } else if (lower.includes(q)) {
            substring.push(project);
        }
    }

    return [...prefix, ...substring];
}

/**
 * Extract the hashtag query at the cursor position.
 * Returns the partial query text and the start index of the `#` character,
 * or null if the cursor isn't inside a `#token`.
 *
 * The `#` must be at the start of the text or preceded by a space.
 */
export function extractHashtagQuery(
    text: string,
    cursorOffset: number,
): { query: string; startIndex: number } | null {
    if (cursorOffset <= 0 || cursorOffset > text.length) return null;

    // Scan backwards from cursor to find '#'
    let hashIndex = -1;
    for (let i = cursorOffset - 1; i >= 0; i--) {
        const ch = text[i];
        if (ch === '#') {
            // '#' must be at start or preceded by a space
            if (i === 0 || text[i - 1] === ' ') {
                hashIndex = i;
            }
            break;
        }
        // Stop scanning if we hit a space (no # in this token)
        if (ch === ' ') break;
    }

    if (hashIndex === -1) return null;

    const query = text.substring(hashIndex + 1, cursorOffset);
    return { query, startIndex: hashIndex };
}
