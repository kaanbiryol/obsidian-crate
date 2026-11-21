// The service command: start Crate at login and keep it running, or stop doing so.
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { installKind } from '../local-server-install.mjs';
import { installService, uninstallService } from '../local-server-service.mjs';

/** @typedef {import('../local-server-options.mjs').Command} Command */

/** @type {Command} */
export async function service({ dataDir, values }) {
	if (values.off) {
		console.log(await uninstallService() ? 'Crate no longer starts automatically. It has been stopped.' : 'Crate was not set to start automatically.');
		return;
	}
	await access(join(dataDir, 'server.json')).catch(() => { throw new Error(`No Crate server data in ${dataDir}. Run setup first, then service.`); });
	if (installKind() === 'npx') throw new Error('A service needs a lasting install. Run npm install -g @kaanbiryol/crate-server, then crate-server service.');
	const { log } = await installService({ dataDir, keepAwake: Boolean(values['keep-awake']) });
	console.log(`Crate now starts when you log in and restarts after a failure.\nLog: ${log}\nStop it with the service --off command.${process.platform === 'linux' ? '\nTo keep it running after you log out, run once: sudo loginctl enable-linger "$USER"' : ''}`);
}
