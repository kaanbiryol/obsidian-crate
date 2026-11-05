import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { startProcess } from './local-server-process.mjs';
import { normalizeTunnelHostname } from './local-server-tunnel.mjs';

const execFileAsync = promisify(execFile);
// The Mac app ships its CLI inside the bundle and does not always add it to PATH.
const MAC_APP_CLI = '/Applications/Tailscale.app/Contents/MacOS/Tailscale';

export async function findTailscale({ platform = process.platform, run = execFileAsync } = {}) {
	for (const command of ['tailscale', ...(platform === 'darwin' ? [MAC_APP_CLI] : [])]) {
		try { await run(command, ['version']); return command; }
		catch (error) { if (error.code !== 'ENOENT') throw error; }
	}
	throw new Error('Install Tailscale and sign in, then rerun setup: https://tailscale.com/download');
}

/** This machine's stable public name, from the signed-in Tailscale client. */
export async function tailscaleHostname(command, { run = execFileAsync } = {}) {
	const { stdout } = await run(command, ['status', '--json']);
	let status;
	try { status = JSON.parse(stdout); }
	catch { throw new Error('Could not read Tailscale status. Update Tailscale, then retry.'); }
	if (status?.BackendState !== 'Running') throw new Error('Tailscale is not connected. Open Tailscale or run tailscale up, sign in, then retry.');
	const name = typeof status.Self?.DNSName === 'string' ? status.Self.DNSName.replace(/\.$/, '') : '';
	if (!name.endsWith('.ts.net')) throw new Error('Turn on MagicDNS and HTTPS certificates for your tailnet, then retry: https://login.tailscale.com/admin/dns');
	return normalizeTunnelHostname(name);
}

/** Runs Funnel in the foreground, so stopping Crate also takes its public address offline.
 * The first run prints a Tailscale link to approve Funnel for this tailnet. */
export async function startTailscaleFunnel(settings, signal, { run = execFileAsync, platform = process.platform, start = startProcess } = {}) {
	const command = await findTailscale({ platform, run });
	const hostname = await tailscaleHostname(command, { run });
	if (hostname !== settings.hostname) {
		throw new Error(`This server was set up for https://${settings.hostname}, but Tailscale now names this computer ${hostname}. Rename the computer back in Tailscale; a new address requires reconnecting every device and PWA.`);
	}
	return start(command, ['funnel', '--https=443', `http://127.0.0.1:${settings.port}`], { signal });
}
