import { PWA_CLIENT_ASSETS, PWA_CLIENT_JS } from './client-bundle';
import { PWA_ASSET_VERSION } from '../../../pwa/shell/version';

export { createPwaHtml } from './html';
export { ICON_SVG } from './icons';
export {
	APPLE_TOUCH_ICON_180_PNG,
	CRATE_ICON_192_PNG,
	CRATE_ICON_512_PNG,
	CRATE_MARK_256_PNG,
} from './install-assets';
export { createManifestJson } from './manifest';
export { OPEN_OBSIDIAN_HTML, OPEN_OBSIDIAN_JS, PAIR_DEVICE_HTML, PAIR_DEVICE_JS } from './open-obsidian';
export { SERVICE_WORKER_JS } from './service-worker';
export { PWA_THEME_BOOTSTRAP_JS } from './theme-bootstrap';

export const PWA_APP_JS = PWA_CLIENT_JS;
export { PWA_CLIENT_ASSETS };

export function createPwaVersionJson(): string {
	return JSON.stringify({ assetVersion: PWA_ASSET_VERSION });
}
