import { HttpError, WorkerApiHttpClient } from './worker-api/http';
import { ConnectionSetupError } from './connection-errors';

export async function exchangeSelfHostedPairingCode(address: string, code: string, signal: AbortSignal): Promise<string> {
	const http = new WorkerApiHttpClient(address, '');
	http.setAbortSignal(signal);
	let result: { authToken?: unknown };
	try {
		result = await http.requestJson('/__crate/pair', {
			method: 'POST', body: JSON.stringify({ code }),
		});
	} catch (error) {
		if (error instanceof HttpError && (error.status === 400 || error.status === 401)) {
			throw new ConnectionSetupError(error.status === 401 ? 'pairing-expired' : 'pairing-invalid', { cause: error });
		}
		throw error;
	}
	if (typeof result.authToken !== 'string' || !/^[a-f0-9]{64}$/.test(result.authToken)) {
		throw new ConnectionSetupError('invalid-pairing-response');
	}
	return result.authToken;
}
