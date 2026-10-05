/** Ownership or checkpoint validation failed before a destructive reset step. */
export class ResetBlockedError extends Error {
  constructor(detail: string) { super(`Reset blocked: ${detail}`); }
}
