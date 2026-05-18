declare const __CRATE_PWA_CLIENT_JS__: string | undefined;

export const PWA_CLIENT_JS =
	typeof __CRATE_PWA_CLIENT_JS__ === 'string' && __CRATE_PWA_CLIENT_JS__.length > 0
		? __CRATE_PWA_CLIENT_JS__
		: 'console.error("Crate PWA client bundle was not generated before build.");';
