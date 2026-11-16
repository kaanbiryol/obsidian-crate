// Device administration: pairing codes, offline tokens, listing and revocation.
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveServerOrigin, resolveStartMode } from '../local-server-options.mjs';
import { requestLocalControl, requestLocalPairing } from '../local-server-pairing.mjs';
import { issueLocalDevice, listLocalDevices, openLocalRuntime, revokeLocalDevice } from '../local-server-runtime.mjs';

/** @typedef {import('../local-server-options.mjs').Command} Command */

/** @param {{ code: string }} pairing */
export function printPairing(pairing) {
	console.log(`Pairing code (single use, expires in 10 minutes): ${pairing.code}\nPaste this code into Crate → Connect to your server. Keep it private.`);
}

/** Uses the running server's control socket, or opens the stopped server's data.
 * @template T
 * @param {string} dataDir
 * @param {string} method
 * @param {string} path
 * @param {unknown} body
 * @param {(admin: import('../local-server-runtime.mjs').LocalRuntime) => Promise<T>} offline
 * @returns {Promise<T>} */
async function administer(dataDir, method, path, body, offline) {
	try { return await requestLocalControl(dataDir, method, path, body); }
	catch (error) {
		if (error.code !== 'ENOENT') throw new Error(error.message || 'Could not reach the running server. Keep Crate running, check the data directory, then try again.');
	}
	// Never initialize an empty directory as a side effect of administration.
	await access(join(dataDir, 'server.json')).catch(() => { throw new Error(`No Crate server data in ${dataDir}. Pass the server's --data-dir.`); });
	const admin = await openLocalRuntime({ dataDir, administrative: true, handleSignals: false });
	try { return await offline(admin); } finally { await admin.close(); }
}

/** @param {import('../local-server-runtime.mjs').LocalDevice[]} devices */
function printDevices(devices) {
	if (!devices.length) { console.log('No devices are connected.'); return; }
	/** @type {Record<string, string>} */
	const labels = { vault: 'Obsidian', reminders: 'Reminders web app', reading_capture: 'Reading shortcut' };
	for (const device of devices) {
		console.log(`${device.id}  ${device.name || 'Unnamed'} · ${labels[device.scope] ?? device.scope}${device.platform ? ` (${device.platform})` : ''} · last seen ${device.lastSeenAt ?? 'never'} UTC`);
	}
	console.log('Revoke one with the revoke command and --id TOKEN_ID.');
}

/** @param {string | undefined} name @param {{ id: string, token: string }} credential */
function printDevice(name, credential) {
	console.log(`Device: ${name}\nToken ID: ${credential.id}\nAccess token (shown once): ${credential.token}\nPaste this token into Crate → Connect to your server. Keep it private.`);
}

/** @type {Command} */
export async function listDevices({ dataDir }) {
	printDevices((await administer(dataDir, 'GET', '/devices', undefined, async admin => ({ devices: await listLocalDevices(admin.db) }))).devices);
}

/** @type {Command} */
export async function revoke({ dataDir, values }) {
	if (!values.id?.trim()) throw new Error('Provide --id with a token ID from the devices command.');
	const id = values.id.trim();
	const { revoked } = await administer(dataDir, 'POST', '/revoke', { id }, async admin => ({ revoked: await revokeLocalDevice(admin, id) }));
	if (!revoked) throw new Error('No device has that token ID. Run the devices command to list current IDs.');
	console.log('Device revoked. It can no longer sync; pair it again to reconnect.');
}

/** Asks the running server for a pairing code. @type {Command} */
export async function pair({ dataDir, values }) {
	const pairing = await requestLocalPairing(dataDir, values.name);
	console.log(`Server address to paste into Obsidian: ${pairing.origin}`);
	printPairing(pairing);
}

/** Issues a token offline, so the server must be stopped. It resolves the listener and
 * origin like start does, so the same options are validated. @type {Command} */
export async function addDevice({ dataDir, values, signal }, resources) {
	const { tailscale, port, host } = resolveStartMode('add-device', values, null);
	signal.throwIfAborted();
	const origin = resolveServerOrigin({ remote: null, tailscale, origin: values.origin, port, host });
	const runtime = resources.runtime = await openLocalRuntime({ dataDir, origin, administrative: true, handleSignals: false });
	signal.throwIfAborted();
	// Without a reset generation, issueLocalDevice always returns a credential.
	printDevice(values.name, /** @type {{ id: string, token: string }} */ (await issueLocalDevice(runtime.db, values.name)));
}
