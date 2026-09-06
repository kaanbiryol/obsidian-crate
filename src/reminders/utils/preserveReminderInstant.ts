/** Keep seconds and DST-fold identity when minute-precision editing controls
 * still show the original local date and time. */
export function preserveReminderInstant(candidate: string | undefined | null, original: string | undefined): string | undefined {
  const minute = (value: string) => {
    const date = new Date(value);
    return Math.floor(date.getTime() / 60_000) - date.getTimezoneOffset();
  };
  return candidate && original && minute(candidate) === minute(original) ? original : candidate ?? undefined;
}
