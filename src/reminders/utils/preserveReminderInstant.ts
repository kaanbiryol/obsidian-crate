/** Keep seconds and DST-fold identity when minute-precision editing controls
 * still show the original local date and time. Parsed title text uses full
 * precision so an explicit seconds edit can replace the original instant. */
export function preserveReminderInstant(candidate: string | undefined | null, original: string | undefined, fullPrecision = false): string | undefined {
  const precision = fullPrecision ? 1 : 60_000;
  const localTime = (value: string) => {
    const date = new Date(value);
    return Math.floor((date.getTime() - date.getTimezoneOffset() * 60_000) / precision);
  };
  return candidate && original && localTime(candidate) === localTime(original) ? original : candidate ?? undefined;
}
