import { describe, expect, it } from 'vitest';
import { ReadingApiError } from '../reading/api-error';
import { ConnectionError, connectionIssue } from './issues';

describe('connection recovery boundary', () => {
  it('preserves explicit recovery intent and transport status without inspecting copy', () => {
    expect(connectionIssue(new ConnectionError('cleanup', 'Device storage failed'))).toEqual({ kind: 'cleanup', message: 'Device storage failed' });
    expect(connectionIssue(new ReadingApiError('Access denied', 401))).toEqual({ kind: 'reconnect', message: 'Access denied' });
    expect(connectionIssue(new Error('Session expired'))).toEqual({ kind: 'unavailable', message: 'Session expired' });
  });
});
