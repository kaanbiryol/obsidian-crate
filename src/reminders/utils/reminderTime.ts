import * as chrono from 'chrono-node';
import { parseReminderTimezoneSuffix } from './reminderTimezone';

/** Chrono's casual periods imply an hour rather than marking it certain. */
export function hasReminderTime(result: chrono.ParsedResult): boolean {
    return result.start.isCertain('hour') || [...result.tags()]
        .some(tag => /^casualReference\/(?:morning|afternoon|evening|tonight)$/.test(tag));
}

interface RecurrenceTime {
    text: string;
    hour?: number;
    minute?: number;
    second?: number;
    millisecond?: number;
    timezone?: string;
    error?: string;
}

function isTimeOnly(result: chrono.ParsedResult): boolean {
    return hasReminderTime(result) && !(['year', 'month', 'day'] as const)
        .some(component => result.start.isCertain(component) || result.end?.isCertain(component));
}

function readTime(text: string, referenceDate: Date): { result: chrono.ParsedResult; length: number } | undefined {
    // A weekday gives bare clocks the same context as "Monday at 9", without
    // letting an unrelated later calendar date become part of this repeat.
    const anchor = 'Monday ';
    const anchored = chrono.parse(anchor + text, referenceDate, { forwardDate: true })[0];
    if (anchored?.index === 0 && isTimeOnly(anchored)) {
        return { result: anchored, length: anchored.text.length - anchor.length };
    }
    // Preserve existing forms such as "daily in the morning". Chrono reads
    // the time itself but does not merge this connector with a weekday.
    const standalone = chrono.parse(text, referenceDate, { forwardDate: true })[0];
    if (standalone && isTimeOnly(standalone) && !standalone.start.isCertain('weekday')
        && /^\s*(?:in\s+the\s+)?$/i.test(text.slice(0, standalone.index))) {
        return { result: standalone, length: standalone.index + standalone.text.length };
    }
    return undefined;
}

/** Consume a complete Chrono time phrase, then retain its repeat timezone. */
export function parseRecurrenceTime(text: string, sourceText: string, referenceDate: Date): RecurrenceTime {
    let parsed = readTime(text, referenceDate);
    let length = parsed?.length ?? 0;
    let clockText = text;
    let error: string | undefined;
    const zones: Array<{ index: number; text: string; timezone?: string; error?: string }> = [];

    // Chrono may include an abbreviation or offset in its result. Resolve the
    // actual written suffix through the same timezone helper used by one-offs.
    for (const boundary of sourceText.slice(0, length).matchAll(/\s+|(?=[+-]\d)/g)) {
        if (zones.some(zone => boundary.index < zone.index + zone.text.length)) continue;
        const zone = parseReminderTimezoneSuffix(sourceText.slice(boundary.index), referenceDate);
        if (zone) zones.push({ index: boundary.index, ...zone });
    }
    length = Math.max(length, ...zones.map(zone => zone.index + zone.text.length));
    const suffix = parseReminderTimezoneSuffix(sourceText.slice(length), referenceDate);
    if (suffix) {
        zones.push({ index: length, ...suffix });
        length += suffix.text.length;
        const extra = parseReminderTimezoneSuffix(sourceText.slice(length), referenceDate);
        if (extra) { zones.push({ index: length, ...extra }); length += extra.text.length; }
    }
    if (zones.length) {
        // A bare negative colon offset looks like a range to Chrono. Reading
        // the clock without its zone avoids treating -03:30 as another time.
        for (const zone of [...zones].reverse()) {
            clockText = clockText.slice(0, zone.index) + '\uFFFC'.repeat(zone.text.length)
                + clockText.slice(zone.index + zone.text.length);
        }
        parsed = readTime(clockText.slice(0, length), referenceDate);
        error = zones.find(zone => zone.error)?.error;
        if (zones.length > 1) error = 'Use one timezone per schedule.';
    }

    if (parsed?.result.end) error = 'Use one time per repeat schedule.';

    return { text: sourceText.slice(0, length),
        ...(parsed ? { hour: parsed.result.start.get('hour')!, minute: parsed.result.start.get('minute') ?? 0 } : {}),
        ...(parsed?.result.start.get('second') ? { second: parsed.result.start.get('second')! } : {}),
        ...(parsed?.result.start.get('millisecond') ? { millisecond: parsed.result.start.get('millisecond')! } : {}),
        ...(zones[0]?.timezone ? { timezone: zones[0].timezone } : {}),
        ...(error ? { error } : {}),
    };
}
