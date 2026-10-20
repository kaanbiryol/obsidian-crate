/** The shared command's 1 MiB note limit, answered by the request handler. */
export class ReminderFileSizeError extends Error {
  constructor(message: string) { super(message); this.name = 'ReminderFileSizeError'; }
}
