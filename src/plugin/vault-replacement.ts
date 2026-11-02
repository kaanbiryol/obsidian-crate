import type { App } from 'obsidian';
import { ConnectionSetupError } from '../sync/connection/connection-errors';
import type { SyncApiClient } from '../sync/worker-api/client';
import { openConfirmationModal } from '../ui/plugin/confirmation-modal';

/** Joining a server that has files replaces this vault, so ask first. Resolves
 * whether the first sync must move the vault to trash; Cancel throws. */
export async function confirmVaultReplacement(app: App, api: Pick<SyncApiClient, 'hasFiles'>): Promise<boolean> {
	// Ask whenever the answer is unknown: a confirmed replacement only moves files to trash.
	if (!await api.hasFiles().catch(() => true)) return false;
	const confirmed = await openConfirmationModal(app, {
		title: 'Replace this vault',
		message: 'Everything in this vault will be moved to trash and replaced with the contents of your Crate server.',
		details: ['To keep this vault as it is, select Cancel and connect a new, empty vault instead.'],
		confirmText: 'Replace',
		warning: true,
	});
	if (!confirmed) throw new ConnectionSetupError('replace-cancelled');
	return true;
}
