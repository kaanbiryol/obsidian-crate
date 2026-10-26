import { CRATE_PROTOCOL_HEADER } from '@/protocol/server-info';
import { ConnectionError } from './issues';
import { detectWebSessionName } from './session-label';
import { requireCompatibleProtocol } from './server-compatibility';
import { responseError } from './response-error';

export async function exchangeEnrollmentToken(token: string, previousAuthToken: string | null = null): Promise<string> {
	const protocol = await requireCompatibleProtocol();
	const response = await fetch('/notifications/reminders-exchange', {
		signal: AbortSignal.timeout(30_000),
		method: 'POST',
		headers: { 'Content-Type': 'application/json', [CRATE_PROTOCOL_HEADER]: String(protocol) },
		body: JSON.stringify({ token, deviceName: detectWebSessionName(), ...(previousAuthToken ? { previousAuthToken } : {}) }),
	});

	if (!response.ok) {
		const { message } = await responseError(response, response.status === 401 ? 'This app link is invalid or expired. Open a fresh link from Crate.' : 'Could not connect to Crate. Try again.');
		throw new ConnectionError(response.status === 401 ? 'reconnect' : 'unavailable', message);
	}

	const result = await response.json() as { authToken?: string };
	if (!result.authToken) throw new ConnectionError('reconnect', 'Missing auth token');
	return result.authToken;
}
