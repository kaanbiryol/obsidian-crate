import * as chrono from 'chrono-node';

// Chrono's seasonal abbreviations need a named zone when stored in a repeat
// rule. All other abbreviations use Chrono's fixed offset, without a second map.
const seasonalZones: Record<string, string> = {
    CET: 'Europe/Berlin', ET: 'America/New_York', CT: 'America/Chicago',
    MT: 'America/Denver', PT: 'America/Los_Angeles',
};

export interface ReminderTimezoneSuffix {
    text: string;
    timezone?: string;
    error?: string;
}

export function canonicalReminderTimezone(timezone: string): string {
    const canonical = new Intl.DateTimeFormat('en', { timeZone: timezone }).resolvedOptions().timeZone;
    return canonical === '+00:00' ? 'UTC' : canonical;
}

/** Resolve a suffix with Chrono or the platform's IANA database. */
export function parseReminderTimezoneSuffix(text: string, referenceDate = new Date()): ReminderTimezoneSuffix | undefined {
    const named = /^\s+(?:\()?([A-Za-z_]+\/[A-Za-z0-9_+/-]+)\)?(?=$|[\s,;.!#])/u.exec(text);
    if (named) {
        try {
            const timezone = canonicalReminderTimezone(named[1]!);
            return { text: named[0], timezone };
        } catch {
            if (/^(?:Africa|America|Antarctica|Arctic|Asia|Atlantic|Australia|Europe|Indian|Pacific|Etc|US|Canada)\//i.test(named[1]!)) {
                return { text: named[0], error: `Unknown timezone: ${named[1]}.` };
            }
            return undefined;
        }
    }

    const offset = /^\s*\(?(?:(?:UTC|GMT)\s*)?[+-](?:[\d:]+[\w:]*|(?=$|[\s,;.!#]))\)?/i.exec(text);
    if (offset) {
        // A title separator is ordinary text; an explicit "UTC+" is an
        // unfinished timezone and must not silently save as local time.
        if (!/[\d:]|UTC|GMT/i.test(offset[0])) return undefined;
        const parts = /^\s*\(?(?:(?:UTC|GMT)\s*)?([+-])(\d{1,2})(?::?(\d{2}))?\)?$/i.exec(offset[0]);
        if (!parts || Number(parts[3] ?? 0) > 59 || Number(parts[2]) > 14
            || Number(parts[2]) === 14 && Number(parts[3] ?? 0) !== 0) {
            return { text: offset[0], error: 'Use a valid timezone offset, such as +05:30.' };
        }
    }
    const abbreviation = /^\s*,?\s*\(?([A-Za-z]{1,5})\)?(?=$|[\s,;.!#])/u.exec(text);
    const suffix = offset?.[0] ?? abbreviation?.[0];
    if (!suffix) return undefined;
    const prefix = '2000-01-15 09:00';
    // An explicit UTC prefix disambiguates a negative offset from a time range
    // in Chrono. Its offset refiner still owns the numeric interpretation.
    const input = offset ? `${prefix} UTC${suffix.replace(/\s|[()]|UTC|GMT/gi, '')}` : prefix + suffix;
    const result = chrono.parse(input, referenceDate)[0];
    if (!result?.start.isCertain('timezoneOffset') || result.text.length !== input.length) return undefined;
    const minutes = result.start.get('timezoneOffset')!;
    const name = abbreviation?.[1]?.toUpperCase();
    const timezone = name && seasonalZones[name] || (minutes === 0 ? 'UTC'
        : `${minutes < 0 ? '-' : '+'}${String(Math.floor(Math.abs(minutes) / 60)).padStart(2, '0')}:${String(Math.abs(minutes) % 60).padStart(2, '0')}`);
    return { text: suffix, timezone };
}
