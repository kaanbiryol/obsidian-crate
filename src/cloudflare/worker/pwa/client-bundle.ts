declare const __CRATE_PWA_CLIENT_ASSETS__: Record<string, string> | undefined;
declare const __CRATE_PWA_STARTUP_ASSETS__: string[] | undefined;

export const PWA_STARTUP_ASSETS: readonly string[] =
	typeof __CRATE_PWA_STARTUP_ASSETS__ !== 'undefined' ? __CRATE_PWA_STARTUP_ASSETS__ : [];

const fallbackClient = 'console.error("Crate PWA client bundle was not generated before build.");';

export const PWA_CLIENT_ASSETS: Readonly<Record<string, string>> =
	typeof __CRATE_PWA_CLIENT_ASSETS__ === 'object' && __CRATE_PWA_CLIENT_ASSETS__ !== null
		? __CRATE_PWA_CLIENT_ASSETS__
		: { 'app.js': fallbackClient };

export const PWA_CLIENT_JS = PWA_CLIENT_ASSETS['app.js'] ?? fallbackClient;
