// How this server was installed, which decides the commands Crate prints for pairing,
// updating and running it as a service.
import { sep } from 'node:path';
import { packaged } from './assets.mjs';

/** @typedef {'docker' | 'source' | 'npx' | 'npm'} InstallKind */

export const PACKAGE_NAME = '@kaanbiryol/crate-server';

/** @param {{ docker?: boolean, packaged?: boolean, script?: string }} [options] @returns {InstallKind} */
export function installKind({ docker = process.env.CRATE_DOCKER === '1', packaged: isPackaged = packaged, script = process.argv[1] ?? '' } = {}) {
	if (docker) return 'docker';
	if (!isPackaged) return 'source';
	return script.includes(`${sep}_npx${sep}`) ? 'npx' : 'npm';
}

/** The command line that runs a Crate command for this install.
 * @param {InstallKind} kind @param {string} args */
export function crateCommand(kind, args) {
	const prefix = { docker: 'docker compose exec crate crate', source: 'npm run server --', npx: `npx ${PACKAGE_NAME}`, npm: 'crate-server' }[kind];
	return `${prefix} ${args}`;
}
