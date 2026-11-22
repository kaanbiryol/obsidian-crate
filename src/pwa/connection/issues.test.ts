import { describe, expect, it } from 'vitest';
import { ReadingApiError } from '../reading/session/api-error';
import { ConnectionError, connectionIssue, rethrowUnreachable } from './issues';

describe('connection recovery boundary', () => {
	it('preserves explicit recovery intent and transport status without inspecting copy', () => {
		expect(connectionIssue(new ConnectionError('cleanup', 'Device storage failed'))).toEqual({ kind: 'cleanup', message: 'Device storage failed' });
		expect(connectionIssue(new ReadingApiError('Access denied', 401))).toEqual({ kind: 'reconnect', message: 'Access denied' });
		expect(connectionIssue(new Error('Session expired'))).toEqual({ kind: 'unavailable', message: 'Session expired' });
	});

	it('turns a fetch that got no answer into readable copy, and leaves other errors alone', () => {
		for (const failure of [new TypeError('Load failed'), new DOMException('The operation timed out.', 'TimeoutError')]) {
			let thrown: unknown;
			try { rethrowUnreachable(failure); } catch (error) { thrown = error; }
			expect(connectionIssue(thrown)).toEqual({ kind: 'unavailable', network: true, message: 'Crate couldn’t be reached. Check your connection and try again.' });
		}
		const aborted = new DOMException('Aborted', 'AbortError');
		expect(() => rethrowUnreachable(aborted)).toThrow(aborted);
	});
});
