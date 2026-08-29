import appleTouchIcon180 from './assets/apple-touch-icon-180.png';
import appleStartup1179x2556Base64 from './assets/apple-startup-1179x2556.png.b64?raw-text';
import appleStartup1206x2622Base64 from './assets/apple-startup-1206x2622.png.b64?raw-text';
import appleStartup1290x2796Base64 from './assets/apple-startup-1290x2796.png.b64?raw-text';
import crateIcon192 from './assets/crate-icon-192.png';
import crateIcon512 from './assets/crate-icon-512.png';
import crateMark256 from './assets/crate-mark-256.png';

function decodeBase64Asset(value: string): Uint8Array {
	const binary = atob(value.replace(/\s/g, ''));
	return Uint8Array.from(binary, character => character.charCodeAt(0));
}

export const APPLE_STARTUP_1179X2556_PNG = decodeBase64Asset(appleStartup1179x2556Base64);
export const APPLE_STARTUP_1206X2622_PNG = decodeBase64Asset(appleStartup1206x2622Base64);
export const APPLE_STARTUP_1290X2796_PNG = decodeBase64Asset(appleStartup1290x2796Base64);
export const APPLE_TOUCH_ICON_180_PNG = appleTouchIcon180;
export const CRATE_ICON_192_PNG = crateIcon192;
export const CRATE_ICON_512_PNG = crateIcon512;
export const CRATE_MARK_256_PNG = crateMark256;
