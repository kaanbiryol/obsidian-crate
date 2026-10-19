import type CratePlugin from '../../main';
import type { SyncApiClient } from '../../sync/api';
import { buildSharedSettings } from '../../sync/runtime-config';

type SharedSettingsPlugin = Pick<CratePlugin, 'settings'> & {
	syncRuntime?: Pick<CratePlugin['syncRuntime'], 'getApiClient' | 'pushSharedSettingsBestEffort'>;
};

/** Closing settings without changes must not re-encrypt and upload them. */
export function createSharedSettingsPush(plugin: SharedSettingsPlugin): () => void {
	let lastPushed: { api: SyncApiClient; json: string } | undefined;
	return () => {
		const runtime = plugin.syncRuntime;
		const api = runtime?.getApiClient();
		if (!runtime || !api) return;
		const json = JSON.stringify(buildSharedSettings(plugin.settings));
		if (lastPushed?.api === api && lastPushed.json === json) return;
		const pushed = { api, json };
		lastPushed = pushed;
		void runtime.pushSharedSettingsBestEffort().then(success => {
			if (!success && lastPushed === pushed) lastPushed = undefined;
		});
	};
}
