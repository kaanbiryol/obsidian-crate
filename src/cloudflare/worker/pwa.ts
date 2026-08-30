import { PWA_CLIENT_JS } from './pwa-client-bundle';
import { PWA_ASSET_VERSION } from './pwa-version';

export { createPwaHtml } from './pwa/html';
export { ICON_SVG } from './pwa/icons';
export {
	APPLE_TOUCH_ICON_180_PNG,
	CRATE_ICON_192_PNG,
	CRATE_ICON_512_PNG,
	CRATE_MARK_256_PNG,
} from './pwa/install-assets';
export { createManifestJson } from './pwa/manifest';
export { OPEN_OBSIDIAN_HTML, OPEN_OBSIDIAN_JS } from './pwa/open-obsidian';
export { SERVICE_WORKER_JS } from './pwa/service-worker';
export { PWA_THEME_BOOTSTRAP_JS } from './pwa/theme-bootstrap';

export const PWA_APP_JS = PWA_CLIENT_JS;

export function createPwaVersionJson(): string {
	return JSON.stringify({ assetVersion: PWA_ASSET_VERSION });
}
