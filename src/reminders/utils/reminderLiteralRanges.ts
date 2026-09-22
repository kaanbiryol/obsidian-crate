/** Addresses and file references are title text, even when they contain dates. */
export function findReminderLiteralRanges(text: string): Array<{ index: number; length: number }> {
    const ranges: Array<{ index: number; length: number }> = [];
    for (const match of text.matchAll(/[^\s"'()[\]{}<>,;]+/gu)) {
        const token = match[0].replace(/[.!?]+$/, '');
        // A dotted meridiem immediately after a clock is time syntax, rather
        // than a filename. Both one-off and repeating times belong to Chrono.
        if (/^\d{1,2}(?::\d{2})?[ap]\.m\.?$/i.test(match[0])
            || /^[ap]\.m\.?$/i.test(match[0]) && /\b\d{1,2}(?::\d{2})?\s+$/u.test(text.slice(0, match.index))) continue;
        const email = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+/u.test(token);
        // An alphabetic extension distinguishes files/hosts from numeric dates
        // and decimals. A trailing slash, port or query belongs to the host.
        const fileOrHost = /^[\p{L}\p{N}_~.-]+\.[\p{L}][\p{L}\p{N}_-]*(?:[./:?#]|$)/u.test(token);
        // Numeric slash dates are not paths. Absolute paths and paths with
        // named components include extensionless files such as notes/Monday.
        const path = /[/\\]/.test(token) && (/^[/\\]/.test(token) || /\p{L}/u.test(token));
        if (email || fileOrHost || path) ranges.push({ index: match.index, length: match[0].length });
    }
    return ranges;
}
