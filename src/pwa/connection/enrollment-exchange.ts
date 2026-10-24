import { CRATE_PROTOCOL_HEADER } from '@/protocol/server-info';
import { ConnectionError } from './issues';
import { detectWebSessionName } from './session-label';
import { requireCompatibleProtocol } from './server-compatibility';

export async function exchangeEnrollmentToken(token: string, previousAuthToken: string | null = null): Promise<string> {
	const protocol = await requireCompatibleProtocol();
	const response = await fetch('/notifications/reminders-exchange', {
		signal: AbortSignal.timeout(30_000),
		method: 'POST',
		headers: { 'Content-Type': 'application/json', [CRATE_PROTOCOL_HEADER]: String(protocol) },
		body: JSON.stringify({ token, deviceName: detectWebSessionName(), ...(previousAuthToken ? { previousAuthToken } : {}) }),
	});

	if (!response.ok) {
		const body = await response.text().catch(() => '');
		throw new ConnectionError(response.status === 401 ? 'reconnect' : 'unavailable', body || response.statusText);
	}

	const result = await response.json() as { authToken?: string };
	if (!result.authToken) throw new ConnectionError('reconnect', 'Missing auth token');
	return result.authToken;
}
