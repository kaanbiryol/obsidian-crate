const setupMessages = new Set([
	'Connect to a self-hosted server first.',
	'A server connection is already in progress.',
	'The saved access token is missing.',
	'The server connection changed. Reopen settings and try again.',
	'Disconnect this device before connecting another server.',
	'Forget the saved Cloudflare connection before connecting your own server.',
	'Finish the Cloudflare connection before connecting your own server.',
	'Paste the access token generated on your Crate server.',
	'Paste a pairing code or device access token generated on your Crate server.',
	'Pairing code expired or already used. Generate a new code on your server.',
	'Could not redeem this pairing code. Generate a new code and try again.',
	'The server did not return a valid device token. Generate a new pairing code and try again.',
]);

/** Translate connection failures at the UI boundary without exposing response
 * bodies, credentials, or platform-specific network diagnostics in a notice. */
export function selfHostedConnectionMessage(error: unknown, address: string): string {
	const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
	const status = typeof error === 'object' && error !== null && 'status' in error
		&& typeof error.status === 'number' ? error.status : Number(/\bHTTP (\d{3})\b/.exec(message)?.[1]);
	let local = false;
	let temporary = false;
	try {
		const host = new URL(address.trim()).hostname;
		local = ['localhost', '127.0.0.1', '[::1]'].includes(host);
		temporary = host.endsWith('.trycloudflare.com');
	} catch { /* Invalid addresses are explained below. */ }
	if (setupMessages.has(message)) return message;
	if (message === 'Worker URL must use HTTPS (or localhost over HTTP) and be a valid URL') {
		return 'Enter the server address printed by Crate, starting with https://. Use http://localhost only for a local-only server.';
	}
	if (status === 401 || /^(Unauthorized|Invalid (access )?token)\.?$/i.test(message)) {
		return 'This server did not accept your access token. Copy the device token from your Crate server and try again.';
	}
	if (status === 403) {
		return 'This token cannot connect an Obsidian vault. Use a device access token from your server, not a web app enrollment link.';
	}
	if (status === 429) return 'The server is receiving too many requests. Wait a minute, then try again.';
	if (/incompatible.*protocol/i.test(message) || status === 426) {
		return 'This Crate server and plugin use incompatible versions. Update the plugin and server, then try again.';
	}
	if (/ERR_CERT_|ERR_SSL_|certificate|SSL_ERROR/i.test(message)) {
		return 'A secure connection could not be established. Check the HTTPS address and the server’s certificate, then try again.';
	}
	if (/timed?\s*out|ETIMEDOUT|ERR_CONNECTION_TIMED_OUT/i.test(message)) {
		return 'The server took too long to respond. Check that the server computer is awake and online, then try again.';
	}
	if (/ERR_NAME_NOT_RESOLVED|ENOTFOUND|EAI_AGAIN|could not resolve|cannot find.*host/i.test(message)) {
		return temporary
			? 'This tunnel address could not be found. Check the latest HTTPS address in your server logs. If you just started it, wait a moment and try again.'
			: 'The server address could not be found. Check the address and your internet connection, then try again.';
	}
	if (/ERR_CONNECTION_REFUSED|ECONNREFUSED|connection refused|could not connect to the server/i.test(message)) {
		return local
			? 'Crate could not reach a server on this device. Start your local server, or use the HTTPS address from the Docker logs.'
			: 'Crate could not reach your server. Check that it is running and that you copied its current HTTPS address.';
	}
	if (status >= 500 && status <= 599) {
		return temporary
			? 'The tunnel cannot reach Crate right now. Check that the server is running and use the latest HTTPS address from its logs.'
			: 'Your server is temporarily unavailable. Check that it is running, then try again shortly.';
	}
	if (status === 404 || /invalid (JSON response|Crate compatibility metadata)/i.test(message)) {
		return temporary
			? 'Crate was not found at this tunnel address. Copy the latest HTTPS address from your server logs and try again.'
			: 'This address did not return a Crate server. Copy the server address itself, without an app link or page path.';
	}
	if (/abort|cancel/i.test(message)) return 'Connection cancelled. Try again when Crate is ready.';
	return 'Could not connect to Crate. Check that the server is running and that its address and device access token are correct, then try again.';
}

/** Keep useful network guidance in sync surfaces without replacing unrelated errors. */
export function syncConnectionFailureMessage(error: string, address: string): string | null {
	return /ERR_NAME_NOT_RESOLVED|ENOTFOUND|EAI_AGAIN|could not resolve|ERR_CONNECTION_REFUSED|ECONNREFUSED|ERR_CONNECTION_TIMED_OUT|ETIMEDOUT|timed?\s*out|ERR_CERT_|ERR_SSL_/i.test(error)
		? selfHostedConnectionMessage(error, address)
		: null;
}
