import type { DeploymentIntent } from './types';

/** Phones can suspend Obsidian in the background partway through a long Cloudflare
 * operation, so creating, updating, recovering, restoring and deleting servers run only
 * on desktop. Mobile devices still connect to existing servers. */
export const DESKTOP_ONLY_SERVER_CHANGE = 'Server changes run only in Obsidian on a desktop. Open Crate settings on your computer to continue.';

export class DesktopOnlyServerChangeError extends Error {
	constructor() {
		super(DESKTOP_ONLY_SERVER_CHANGE);
		this.name = 'DesktopOnlyServerChangeError';
	}
}

/** Intents that change server resources. Connect and switch change them only when
 * they create a server, which is known once the target is resolved. */
export function changesServer(intent: DeploymentIntent): boolean {
	return intent === 'create' || intent === 'update' || intent === 'delete';
}
