import { Notice } from 'obsidian';
import type CratePlugin from './CratePlugin';
import { getPluginLifecycleSignal } from './lifecycle-state';
import { revealCloudflareOperation } from '../ui/cloudflare/deployment-modal';

/** Starts at most one Cloudflare operation: an open one is shown again, and a
 * running one is reported with `busyMessage`. Returns the plugin lifetime signal,
 * or null when the new operation must not start. */
export function beginCloudflareOperation(plugin: CratePlugin, busyMessage: string): AbortSignal | null {
	const signal = getPluginLifecycleSignal(plugin);
	if (signal.aborted) return null;
	if (revealCloudflareOperation(plugin.app, plugin.getSettingsDocument())) return null;
	if (plugin.cloudflareDeploymentService.isBusy) {
		new Notice(busyMessage);
		return null;
	}
	return signal;
}
