/** Only Crate-owned setup failures may publish these messages without redaction. */
export const CONNECTION_SETUP_MESSAGES = {
	'not-self-hosted': 'Connect to a self-hosted server first.',
	'busy': 'A server connection is already in progress.',
	'missing-token': 'The saved access token is missing.',
	'changed': 'The server connection changed. Reopen settings and try again.',
	'already-connected': 'Disconnect this device before connecting another server.',
	'cloudflare-saved': 'Forget the saved Cloudflare connection before connecting your own server.',
	'cloudflare-pending': 'Finish the Cloudflare connection before connecting your own server.',
	'invalid-token': 'Paste a pairing code or device access token generated on your Crate server.',
	'address-update-required': 'Use Update server address before reconnecting to a different address.',
	'invalid-address': 'Worker URL must use HTTPS (or localhost over HTTP) and be a valid URL',
	'pairing-expired': 'Pairing code expired or already used. Generate a new code on your server.',
	'pairing-invalid': 'Could not redeem this pairing code. Generate a new code and try again.',
	'invalid-pairing-response': 'The server did not return a valid device token. Generate a new pairing code and try again.',
} as const;

export class ConnectionSetupError extends Error {
	constructor(readonly code: keyof typeof CONNECTION_SETUP_MESSAGES, options?: ErrorOptions) {
		super(CONNECTION_SETUP_MESSAGES[code], options);
		this.name = 'ConnectionSetupError';
	}
}
