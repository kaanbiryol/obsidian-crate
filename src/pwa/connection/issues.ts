import { SESSION_RECOVERY_MESSAGE } from './expiration';

export type ConnectionIssueKind = 'cleanup' | 'reconnect' | 'unavailable';
export interface ConnectionIssue {
  kind: ConnectionIssueKind;
  message: string;
}

/** Recovery intent belongs to the failing operation, independently of its copy. */
export class ConnectionError extends Error {
  constructor(readonly kind: ConnectionIssueKind, message: string) { super(message); }
}

export const SESSION_RECOVERY_ISSUE: ConnectionIssue = { kind: 'reconnect', message: SESSION_RECOVERY_MESSAGE };

/** Normalize transport errors at the connection boundary, before rendering. */
export function connectionIssue(cause: unknown): ConnectionIssue {
  const kind = cause instanceof ConnectionError ? cause.kind
    : cause instanceof Error && 'status' in cause && cause.status === 401 ? 'reconnect' : 'unavailable';
  return { kind, message: cause instanceof Error ? cause.message : String(cause) };
}
