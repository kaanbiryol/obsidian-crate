import { SESSION_RECOVERY_MESSAGE } from './expiration';

export type ConnectionIssueKind = 'cleanup' | 'reconnect' | 'unavailable';
export interface ConnectionIssue {
	kind: ConnectionIssueKind;
	message: string;
	/** The request never got an answer, so the network is the likely cause. */
	network?: boolean;
}

/** Recovery intent belongs to the failing operation, independently of its copy. */
export class ConnectionError extends Error {
	constructor(readonly kind: ConnectionIssueKind, message: string, readonly network = false) { super(message); }
}

/** Fetch rejects with a TypeError ("Load failed", "Failed to fetch") when offline or blocked,
 * and with a TimeoutError when its timeout signal fires. */
function isNetworkFailure(error: unknown): boolean {
	return error instanceof TypeError || (error instanceof DOMException && error.name === 'TimeoutError');
}

/** Rethrows a request that got no answer as a readable connection error; aborts and
 * other errors pass through unchanged. */
export function rethrowUnreachable(error: unknown): never {
	if (isNetworkFailure(error)) throw new ConnectionError('unavailable', 'Crate couldn’t be reached. Check your connection and try again.', true);
	throw error;
}

export const SESSION_RECOVERY_ISSUE: ConnectionIssue = { kind: 'reconnect', message: SESSION_RECOVERY_MESSAGE };

/** Normalize transport errors at the connection boundary, before rendering. */
export function connectionIssue(cause: unknown): ConnectionIssue {
	const kind = cause instanceof ConnectionError ? cause.kind
		: cause instanceof Error && 'status' in cause && cause.status === 401 ? 'reconnect' : 'unavailable';
	const network = cause instanceof ConnectionError ? cause.network : isNetworkFailure(cause);
	return { kind, message: cause instanceof Error ? cause.message : String(cause), ...network ? { network } : {} };
}
