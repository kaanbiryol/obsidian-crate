declare const __CRATE_PWA_ASSET_VERSION__: string | undefined;

export const PWA_ASSET_VERSION =
	typeof __CRATE_PWA_ASSET_VERSION__ === 'string' && __CRATE_PWA_ASSET_VERSION__.length > 0
		? __CRATE_PWA_ASSET_VERSION__
		: 'dev';
