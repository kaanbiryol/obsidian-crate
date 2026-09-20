import { WorkerApiHttpClient } from './worker-api/http';

export async function exchangeSelfHostedPairingCode(address: string, code: string, signal: AbortSignal): Promise<string> {
	const http = new WorkerApiHttpClient(address, '');
	http.setAbortSignal(signal);
	const result = await http.requestJson<{ authToken?: unknown }>('/__crate/pair', {
		method: 'POST', body: JSON.stringify({ code }),
	});
	if (typeof result.authToken !== 'string' || !/^[a-f0-9]{64}$/.test(result.authToken)) {
		throw new Error('The server did not return a valid device token. Generate a new pairing code and try again.');
	}
	return result.authToken;
}
