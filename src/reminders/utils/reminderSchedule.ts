import * as chrono from 'chrono-node';
import { fromDate, parseDateTime, toZoned } from '@internationalized/date';
import type { RecurrenceRule } from '../types/reminder';
import type { TextMatch } from './richTextTypes';
import { parseMarkdownLinks } from './markdownLinks';
import { findRecurrenceCandidates } from './recurrenceParser';
import { hasReminderTime } from './reminderTime';
import { formatReminderTime, parseLocalDateKey } from './reminderDate';
import { findReminderLiteralRanges } from './reminderLiteralRanges';
import { parseReminderTimezoneSuffix } from './reminderTimezone';

export type ReminderSchedule =
    | { kind: 'recurrence'; rule: RecurrenceRule }
    | { kind: 'date'; dueDate: Date; hasTime: boolean; absolute: boolean };

function fromChrono(result: chrono.ParsedResult): ReminderSchedule {
    const hasTime = hasReminderTime(result);
    const dueDate = hasTime ? result.start.date() : parseLocalDateKey(
        `${String(result.start.get('year')).padStart(4, '0')}-${String(result.start.get('month')).padStart(2, '0')}-${String(result.start.get('day')).padStart(2, '0')}`,
    );
    const absolute = /\b\d{4}\b/.test(result.text)
        && (['year', 'month', 'day'] as const).every(component => result.start.isCertain(component))
        && (!hasTime || result.start.isCertain('timezoneOffset'));
    return { kind: 'date', dueDate, hasTime, absolute };
}

/** Keep a title's final weekday separate from the calendar date appended on save. */
function lastCalendarDate(result: chrono.ParsedResult, referenceDate: Date): chrono.ParsedResult {
    if (!result.start.isCertain('weekday')
        || !(['year', 'month', 'day'] as const).every(component => result.start.isCertain(component))) return result;
    for (const separator of result.text.matchAll(/,\s*|\s+/g)) {
        const prefix = result.text.slice(0, separator.index);
        const weekday = chrono.parse(prefix, referenceDate, { forwardDate: true })[0];
        if (!weekday || weekday.index !== 0 || weekday.text !== prefix || weekday.end
            || !weekday.start.isCertain('weekday') || weekday.start.isCertain('day') || hasReminderTime(weekday)) continue;
        const offset = separator.index + separator[0].length;
        const suffix = result.text.slice(offset);
        const date = chrono.parse(suffix, referenceDate, { forwardDate: true })[0];
        if (date && date.index === 0 && date.text === suffix && !date.end
            && (['year', 'month', 'day'] as const).every(component => date.start.isCertain(component))) {
            return { ...date, index: result.index + offset, tags: () => date.tags(), date: () => date.date() };
        }
    }
    return result;
}

function chronoMatch(result: chrono.ParsedResult, source: string, referenceDate: Date): TextMatch {
    result = lastCalendarDate(result, referenceDate);
    let schedule = fromChrono(result);
    const suffix = parseReminderTimezoneSuffix(source.slice(result.index + result.text.length), referenceDate);
    let text = result.text;
    // Chrono accepts some rolled offsets (e.g. +1260). Validate only the
    // explicitly written suffix, never its internally inferred timezone.
    const writtenOffset = result.start.isCertain('timezoneOffset') && /(?:\s*(?:UTC|GMT))?\s*[+-]\d[\d:]*\)?$/i.exec(text);
    const offsetError = writtenOffset && parseReminderTimezoneSuffix(writtenOffset[0], referenceDate)?.error;
    if (offsetError) return { text, index: result.index, length: text.length, type: 'date', invalid: true, error: offsetError };
    if (suffix?.error) return { text: text + suffix.text, index: result.index, length: text.length + suffix.text.length,
        type: 'date', invalid: true, error: suffix.error };
    if (suffix?.timezone && schedule.kind === 'date') {
        const extraZone = parseReminderTimezoneSuffix(source.slice(result.index + text.length + suffix.text.length), referenceDate);
        if (extraZone) return { text: text + suffix.text + extraZone.text, index: result.index,
            length: text.length + suffix.text.length + extraZone.text.length,
            type: 'date', invalid: true, error: 'Use one timezone per schedule.' };
        if (result.start.isCertain('timezoneOffset')) {
            if (result.tags().has('result/relativeDateAndTime') || result.tags().has('casualReference/now')) {
                return { text: text + suffix.text, index: result.index, length: text.length + suffix.text.length, type: 'date', schedule };
            }
            return { text: text + suffix.text, index: result.index, length: text.length + suffix.text.length,
                type: 'date', invalid: true, error: 'Use one timezone per schedule.' };
        }
        if (!suffix.text.includes('/')) {
            const zoneText = /^\s*-/.test(suffix.text) ? ` UTC${suffix.text.trim()}` : suffix.text;
            const zoned = chrono.parse(result.text + zoneText, referenceDate, { forwardDate: true })[0];
            if (zoned) schedule = fromChrono(zoned);
            text += suffix.text;
            return { text, index: result.index, length: text.length, type: 'date', schedule };
        }
        // Chrono does not read IANA names. Resolve relative calendar words in
        // that zone, then let the calendar library apply its offset on the date.
        const reference = fromDate(referenceDate, suffix.timezone);
        const zoned = chrono.parse(result.text, { instant: referenceDate, timezone: reference.offset / 60_000 }, { forwardDate: true })[0];
        if (zoned) {
            schedule = fromChrono(zoned);
            if (schedule.kind === 'date' && schedule.hasTime) {
                const c = zoned.start;
                const date = `${String(c.get('year')).padStart(4, '0')}-${String(c.get('month')).padStart(2, '0')}-${String(c.get('day')).padStart(2, '0')}`;
                const time = formatReminderTime(c.get('hour')!, c.get('minute') ?? 0, c.get('second') ?? 0, c.get('millisecond') ?? 0);
                schedule.dueDate = toZoned(parseDateTime(`${date}T${time}`), suffix.timezone).toDate();
                schedule.absolute = /\b\d{4}\b/.test(result.text)
                    && (['year', 'month', 'day'] as const).every(component => c.isCertain(component));
            }
            text += suffix.text;
        }
    }
    return { text, index: result.index, length: text.length, type: 'date', schedule };
}

/** Find complete schedules with the same recurrence grammar used when saving. */
export const findReminderScheduleMatches = (text: string, referenceDate: Date): TextMatch[] => {
    const matches: TextMatch[] = [];
    let remaining = text;
    const mask = (index: number, length: number) => {
        remaining = remaining.slice(0, index) + '\uFFFC'.repeat(length) + remaining.slice(index + length);
    };

    // Protect entire links and project names, including names such as #Tomorrow.
    for (const link of parseMarkdownLinks(text)) mask(link.index, link.fullMatch.length);
    for (const url of remaining.matchAll(/\bhttps?:\/\/[^\s)]+/gi)) mask(url.index, url[0].length);
    for (const literal of findReminderLiteralRanges(remaining)) mask(literal.index, literal.length);

    for (const recurrence of findRecurrenceCandidates(remaining, text, referenceDate)) {
        const { index } = recurrence;
        const { matched, error } = recurrence;
        matches.push({ text: matched, index, length: matched.length, type: 'date', ...(error ? { invalid: true, error }
            : { schedule: { kind: 'recurrence' as const, rule: recurrence.rule } }) });
        mask(index, matched.length);
    }

    // Keep malformed offsets from becoming a later clock, and keep negative
    // colon offsets separate from Chrono's date-range grammar. A spaced dash
    // (09:00 - 10:00) remains a range; a signed suffix (-03:30) is a zone.
    for (const clock of remaining.matchAll(/\b(?:\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?|noon|midnight)\b/gi)) {
        const suffix = text.slice(clock.index + clock[0].length);
        if (!/^\s*\(?(?:(?:UTC|GMT)\s*)?[+-]/i.test(suffix)) continue;
        const zone = parseReminderTimezoneSuffix(suffix, referenceDate);
        if (zone?.error) {
            const matched = clock[0] + zone.text;
            matches.push({ text: matched, index: clock.index, length: matched.length, type: 'date', invalid: true, error: zone.error });
            mask(clock.index, matched.length);
        } else if (zone && /^\s*-\d{1,2}:\d{2}$/.test(zone.text)) {
            mask(clock.index + clock[0].length, zone.text.length);
        }
    }

    for (const result of chrono.parse(remaining, referenceDate, { forwardDate: true })) {
        if (result.end) {
            // A reminder has one date. Keep the range's earlier endpoint and
            // connector in the title. Chrono must consume both endpoints:
            // a hyphen inside an ISO date/offset is not a separator.
            let endpoint: chrono.ParsedResult | undefined;
            for (const separator of result.text.matchAll(/\s+(?:to|through|until|till)\s+|\s*[-–—]\s*/gi)) {
                const prefix = result.text.slice(0, separator.index);
                const start = chrono.parse(prefix, referenceDate, { forwardDate: true })[0];
                if (!start || start.end || start.index !== 0 || start.text !== prefix) continue;
                const offset = separator.index + separator[0].length;
                const suffix = result.text.slice(offset);
                const end = chrono.parse(suffix, referenceDate, { forwardDate: true })[0];
                if (end && !end.end && end.index === 0 && end.text === suffix) {
                    // Resolve the last written date independently, as with
                    // "Monday with Friday", even if Chrono orders the range.
                    endpoint = { ...end, index: result.index + offset, tags: () => end.tags(), date: () => end.date() };
                    break;
                }
            }
            if (endpoint) {
                matches.push(chronoMatch(endpoint, text, referenceDate));
            } else {
                matches.push({ text: result.text, index: result.index, length: result.text.length, type: 'date', invalid: true,
                    error: 'Use a complete end date for the reminder.' });
            }
        } else {
            matches.push(chronoMatch(result, text, referenceDate));
        }
    }
    return matches;
};
