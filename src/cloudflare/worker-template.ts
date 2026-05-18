/**
 * Worker script - bundled from src/cloudflare/worker/ by scripts/build-worker.mjs
 */
declare const __CRATE_WORKER_SCRIPT__: string | undefined;

const FALLBACK_WORKER_SCRIPT = `
export default {
	async fetch() {
		return new Response("Crate worker bundle was not generated before build.", { status: 503 });
	},
};
`;

export function getWorkerScript(): string {
	return typeof __CRATE_WORKER_SCRIPT__ === 'string' && __CRATE_WORKER_SCRIPT__.length > 0
		? __CRATE_WORKER_SCRIPT__
		: FALLBACK_WORKER_SCRIPT;
}
