// Command-line option rules for the local server CLI. These checks run before any
// data directory, tunnel or listener is opened; local-server.mjs owns the rest.

const COMMANDS = ['start', 'setup', 'add-device', 'pair', 'devices', 'revoke', 'backup', 'restore', 'check-upgrade', 'upgrade'];
const LOOPBACK_HOSTS = ['127.0.0.1', '::1', 'localhost'];

/** Rejects an unknown command or conflicting options. `dockerWithoutTailscale` reports a
 * container that cannot reach a Tailscale daemon; it runs only for --tailscale. */
export function validateCommandOptions(positionals, values, { dockerWithoutTailscale = () => false } = {}) {
	const command = positionals[0];
	if (positionals.length !== 1 || !COMMANDS.includes(command)) throw new Error('Unknown command. Use --help for usage.');
	if (command === 'setup' && (values.local || values.host || values.origin)) throw new Error('Setup uses a loopback listener and --hostname for the public address.');
	if (values.quick && (values.hostname || values.local || values.origin || values.host || command === 'add-device')) throw new Error('--quick cannot be combined with hostname, local, origin, host, or add-device.');
	if (command !== 'setup' && values.hostname) throw new Error('--hostname belongs to setup. Use --origin for an external reverse proxy.');
	if (values.tailscale && (command !== 'setup' || values.hostname || values.quick)) throw new Error('--tailscale belongs to setup and cannot be combined with --hostname or --quick. Later starts reuse it.');
	if (values.tailscale && dockerWithoutTailscale()) throw new Error('In Docker, start Tailscale Funnel with compose.tailscale.yaml. See docs/self-hosting.md.');
	if (command === 'add-device' && !values.name?.trim()) throw new Error('Provide --name for this device.');
	if (values.name !== undefined && (!values.name.trim() || values.name.trim().length > 128)) throw new Error('Provide a device name between 1 and 128 characters.');
}

/** Chooses a Quick Tunnel, Tailscale Funnel, saved named tunnel or local listener from the
 * options and the directory's saved remote settings (`remote` is null with --local or add-device). */
export function resolveStartMode(command, values, remote) {
	const quick = values.quick || remote?.mode === 'quick' || (command === 'setup' && !remote && !values.hostname && !values.tailscale);
	if (values.tailscale && remote && remote.mode !== 'tailscale') throw new Error('This directory already uses another remote access setup. Keep it or choose another data directory.');
	const tailscale = values.tailscale || remote?.mode === 'tailscale';
	if (tailscale && command === 'setup' && values.hostname) throw new Error('This directory uses Tailscale Funnel. Its address comes from Tailscale, not --hostname.');
	if (quick && (values.hostname || values.origin || values.host || (remote && remote.mode !== 'quick'))) throw new Error('Quick Tunnel and named tunnel settings cannot be combined.');
	const port = values.port === undefined ? remote?.port ?? (quick ? 0 : 8787) : Number(values.port);
	if (!Number.isInteger(port) || port < (quick ? 0 : 1) || port > 65535) throw new Error('Port must be between 1 and 65535 (or 0 for an automatic Quick Tunnel port).');
	const host = values.host ?? '127.0.0.1';
	if (!quick && remote && (port !== remote.port || host !== '127.0.0.1' || (values.origin && values.origin !== `https://${remote.hostname}`))) {
		throw new Error('Saved tunnel settings require their original hostname, port, and loopback listener. Use --local for an independent reverse proxy.');
	}
	return { quick, tailscale, port, host };
}

/** The server's public origin once any setup has saved `remote`. A listener beyond
 * localhost needs an HTTPS origin. */
export function resolveServerOrigin({ remote, tailscale, origin, port, host }) {
	if (remote && !tailscale && !remote.ready) throw new Error('Remote setup is incomplete. Run npm run server -- setup again.');
	const resolved = remote ? `https://${remote.hostname}` : origin ?? `http://localhost:${port}`;
	if (!LOOPBACK_HOSTS.includes(host) && !resolved.startsWith('https://')) {
		throw new Error('Listening beyond localhost requires --origin with the HTTPS address of your reverse proxy.');
	}
	return resolved;
}
