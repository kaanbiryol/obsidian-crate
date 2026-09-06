import { REMINDER_INDEX_MAX_FILE_BYTES } from './reminder-cache/types';
export class ReminderFileSizeError extends Error {
  constructor() { super('Split reminder notes larger than 1 MiB before editing them in the web app.'); this.name = 'ReminderFileSizeError'; }
}
export function validateReminderFileContent(content: string): string {
  if (new TextEncoder().encode(content).byteLength > REMINDER_INDEX_MAX_FILE_BYTES) throw new ReminderFileSizeError();
  return content;
}
