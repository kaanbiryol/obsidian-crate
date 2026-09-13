import { Notice, Setting } from 'obsidian';
import type CratePlugin from '../../main';
import { openConfirmationModal } from '../confirmation-modal';

export function renderAccountActions(container: HTMLElement, plugin: CratePlugin, rerender: () => void): void {
	const accountId = plugin.settings.cloudflareDeployment?.accountId;
	if (!plugin.cloudflareUsageConnection?.connected) return;
	new Setting(container).setName('Cloudflare login')
		.setDesc('Sign out to remove the saved Cloudflare login. Device sync continues; server actions and usage will require sign-in again.')
		.addButton(button => button.setButtonText('Sign out of Cloudflare').onClick(async () => {
			const confirmed = await openConfirmationModal(plugin.app, {
				title: 'Sign out of Cloudflare', message: 'Remove the saved Cloudflare login for this account?',
				details: ['Crate will request revocation in Cloudflare. Other vaults on this device using the same saved account login will also need to sign in again. Sync credentials, vault files, and server resources are kept.'],
				confirmText: 'Sign out',
			});
			if (!confirmed) return;
			if (accountId !== plugin.settings.cloudflareDeployment?.accountId) { new Notice('Account changed. Open the sign-out confirmation again.'); return; }
			button.setDisabled(true);
			try {
				plugin.cloudflareDeploymentService.cancelPendingDeployment();
				await plugin.cloudflareUsageConnection.disconnect();
				new Notice('Signed out of Cloudflare');
			} catch (error) { new Notice(error instanceof Error ? error.message : 'Could not sign out.'); }
			finally { rerender(); }
		}));
}
