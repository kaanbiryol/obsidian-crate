declare const __CRATE_PWA_ASSET_VERSION__: string | undefined;

/** Shell metadata naming the asset version the PWA client was loaded with. */
export const PWA_ASSET_VERSION_META = 'crate-pwa-asset-version';

// The PWA client build omits the constant so its shared chunks stay
// content-stable across deploys; it reads the version from its shell instead.
type ShellDocument = { querySelector(selector: string): { getAttribute(name: string): string | null } | null };
function shellAssetVersion(): string | null | undefined {
	const document = (globalThis as { document?: ShellDocument }).document;
	return document?.querySelector(`meta[name="${PWA_ASSET_VERSION_META}"]`)?.getAttribute('content');
}

export const PWA_ASSET_VERSION =
	typeof __CRATE_PWA_ASSET_VERSION__ === 'string' && __CRATE_PWA_ASSET_VERSION__.length > 0
		? __CRATE_PWA_ASSET_VERSION__
		: shellAssetVersion() || 'dev';
