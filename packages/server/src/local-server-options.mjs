// Command-line option rules for the local server CLI. These checks run before any
// data directory, tunnel or listener is opened; local-server.mjs and commands/ own the rest.

/**
 * The parsed command-line options.
 * @typedef {object} CommandOptions
 * @property {string} [data-dir]
 * @property {string} [port]
 * @property {string} [host]
 * @property {string} [origin]
 * @property {string} [output]
 * @property {string} [backup]
 * @property {string} [keep]
 * @property {string} [hostname]
 * @property {string} [name]
 * @property {string} [id]
 * @property {boolean} [local]
 * @property {boolean} [keep-awake]
 * @property {string} [max-file-size] Largest synced file in MB.
 * @property {boolean} [quick]
 * @property {boolean} [tailscale]
 * @property {boolean} [off]
 * @property {boolean} [help]
 * @property {boolean} [json]
 */

/**
 * What the CLI entry passes each command.
 * @typedef {object} CommandContext
 * @property {string} command
 * @property {CommandOptions} values
 * @property {string} dataDir
 * @property {boolean} docker Runs in the Crate container.
 * @property {AbortSignal} signal Aborts on SIGINT, SIGTERM or SIGHUP.
 * @property {Promise<unknown>} stopped Settles once `signal` aborts.
 */

/**
 * A command records each resource in `resources` as soon as it opens, so the entry
 * closes whatever opened, in order, even after a failure.
 * @typedef {(context: CommandContext, resources: import('./local-server-lifecycle.mjs').CommandResources) => Promise<void>} Command
 */

const COMMANDS = ['start', 'setup', 'add-device', 'pair', 'devices', 'revoke', 'status', 'backup', 'auto-backup', 'restore', 'check-upgrade', 'upgrade', 'service', 'update', 'doctor'];
const LOOPBACK_HOSTS = ['127.0.0.1', '::1', 'localhost'];

/** Rejects an unknown command or conflicting options. `dockerWithoutTailscale` reports a
 * container that cannot reach a Tailscale daemon; it runs only for --tailscale.
 * @param {string[]} positionals
 * @param {CommandOptions} values
 * @param {{ dockerWithoutTailscale?: () => boolean }} [checks] */
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
	if (values.keep !== undefined && command !== 'auto-backup') throw new Error('--keep belongs to auto-backup.');
	if (values.off && !['auto-backup', 'service'].includes(command)) throw new Error('--off belongs to auto-backup and service.');
	if (values['keep-awake'] && !['start', 'setup', 'service'].includes(command)) throw new Error('--keep-awake belongs to start, setup and service.');
	if (values.json && command !== 'check-upgrade') throw new Error('--json belongs to check-upgrade.');
	if (values['keep-awake'] && values.off) throw new Error('--keep-awake cannot be combined with --off.');
	if (values['max-file-size'] !== undefined && !['start', 'setup', 'service'].includes(command)) throw new Error('--max-file-size belongs to start, setup and service.');
	if (values['max-file-size'] !== undefined) maxFileSizeBytes(values['max-file-size']);
}

// Mirrors MAX_FILE_SIZE_BYTES and MAX_CONFIGURABLE_FILE_BYTES in src/protocol/sync-limits.ts.
export const MIN_FILE_MB = 25, MAX_FILE_MB = 1024;

/** Bytes for a whole number of MB between the default and the ceiling. @param {string} value */
function maxFileSizeBytes(value) {
	const mb = /^\d+$/.test(value.trim()) ? Number(value) : NaN;
	if (!Number.isInteger(mb) || mb < MIN_FILE_MB || mb > MAX_FILE_MB) throw new Error(`--max-file-size must be a whole number of MB from ${MIN_FILE_MB} to ${MAX_FILE_MB}.`);
	return mb * 1024 * 1024;
}

/** The largest synced file from --max-file-size or CRATE_MAX_FILE_SIZE_MB (Docker), or
 * undefined for the default 25 MB. @param {CommandOptions} values @param {NodeJS.ProcessEnv} [env] */
export function resolveMaxFileBytes(values, env = process.env) {
	const value = values['max-file-size'] ?? (env.CRATE_MAX_FILE_SIZE_MB?.trim() || undefined);
	return value === undefined ? undefined : maxFileSizeBytes(value);
}

/** Chooses a Quick Tunnel, Tailscale Funnel, saved named tunnel or local listener from the
 * options and the directory's saved remote settings (`remote` is null with --local or add-device).
 * @param {string} command
 * @param {CommandOptions} values
 * @param {import('./local-server-tunnel.mjs').RemoteSettings | null} remote */
export function resolveStartMode(command, values, remote) {
	// A Quick Tunnel address never outlives a restart, so setup may replace it with a stable one.
	if (replacesQuickTunnel(command, values, remote)) remote = null;
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

/** Whether setup is moving a saved Quick Tunnel to Tailscale Funnel or a named tunnel.
 * @param {string} command
 * @param {CommandOptions} values
 * @param {import('./local-server-tunnel.mjs').RemoteSettings | null} remote */
export function replacesQuickTunnel(command, values, remote) {
	return command === 'setup' && remote?.mode === 'quick' && Boolean(values.tailscale || values.hostname);
}

/** The server's public origin once any setup has saved `remote`. A listener beyond
 * localhost needs an HTTPS origin.
 * @param {object} options
 * @param {import('./local-server-tunnel.mjs').RemoteSettings | null} options.remote
 * @param {boolean} options.tailscale
 * @param {string} [options.origin]
 * @param {number} options.port
 * @param {string} options.host
 * @returns {string} */
export function resolveServerOrigin({ remote, tailscale, origin, port, host }) {
	if (remote && !tailscale && !remote.ready) throw new Error('Remote setup is incomplete. Run npm run server -- setup again.');
	const resolved = remote ? `https://${remote.hostname}` : origin ?? `http://localhost:${port}`;
	if (!LOOPBACK_HOSTS.includes(host) && !resolved.startsWith('https://')) {
		throw new Error('Listening beyond localhost requires --origin with the HTTPS address of your reverse proxy.');
	}
	return resolved;
}
