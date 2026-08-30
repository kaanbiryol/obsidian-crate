import { stat } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { readFile } from 'node:fs/promises';

const budgetGroups = {
	plugin: [{
		path: 'dist/main.js',
		// Includes the compressed, integrity-checked Worker and PWA used by OAuth deployment.
		maxBytes: Number.parseInt(process.env.CRATE_MAIN_JS_BUDGET_BYTES ?? '1450000', 10),
		maxGzipBytes: Number.parseInt(process.env.CRATE_MAIN_JS_GZIP_BUDGET_BYTES ?? '820000', 10),
	},
	{
		path: 'dist/styles.css',
		// Owned selector prefixes and shared cross-host UI rules add raw bytes without materially affecting transfer size.
		maxBytes: Number.parseInt(process.env.CRATE_STYLES_BUDGET_BYTES ?? '125000', 10),
		maxGzipBytes: Number.parseInt(process.env.CRATE_STYLES_GZIP_BUDGET_BYTES ?? '20000', 10),
	}],
	worker: [{
		path: '.generated/cloudflare/worker.mjs',
		// The deployable Worker embeds the complete reminders PWA assets.
		maxBytes: Number.parseInt(process.env.CRATE_WORKER_BUDGET_BYTES ?? '1430000', 10),
		maxGzipBytes: Number.parseInt(process.env.CRATE_WORKER_GZIP_BUDGET_BYTES ?? '615000', 10),
	}],
	pwa: [{
		path: '.generated/cloudflare/pwa-client.json',
		assetName: 'app.js',
		maxBytes: Number.parseInt(process.env.CRATE_PWA_ENTRY_BUDGET_BYTES ?? '80000', 10),
		maxGzipBytes: Number.parseInt(process.env.CRATE_PWA_ENTRY_GZIP_BUDGET_BYTES ?? '25000', 10),
	}, {
		path: '.generated/cloudflare/pwa-client.json',
		allAssets: true,
		maxBytes: Number.parseInt(process.env.CRATE_PWA_TOTAL_BUDGET_BYTES ?? '465000', 10),
		maxGzipBytes: Number.parseInt(process.env.CRATE_PWA_TOTAL_GZIP_BUDGET_BYTES ?? '145000', 10),
	}],
};

const requestedGroup = process.argv[2] ?? 'all';
const budgets = requestedGroup === 'all'
	? Object.values(budgetGroups).flat()
	: budgetGroups[requestedGroup];
if (!budgets) {
	throw new Error(`Unknown size budget group: ${requestedGroup}`);
}

function formatBytes(value) {
	return `${(value / 1024).toFixed(2)} KiB`;
}

async function getFileSizes(budget) {
	const { path } = budget;
	if (budget.assetName || budget.allAssets) {
		const payload = JSON.parse(await readFile(path, 'utf-8'));
		const assets = payload?.assets;
		if (!assets || typeof assets !== 'object') throw new Error(`Missing PWA assets in ${path}`);
		const sources = budget.allAssets ? Object.values(assets) : [assets[budget.assetName]];
		if (sources.some(source => typeof source !== 'string')) throw new Error(`Missing PWA asset in ${path}`);
		return sources.reduce((sizes, source) => ({
			rawBytes: sizes.rawBytes + Buffer.byteLength(source),
			gzipBytes: sizes.gzipBytes + gzipSync(source).length,
		}), { rawBytes: 0, gzipBytes: 0 });
	}
	const [fileStat, content] = await Promise.all([stat(path), readFile(path)]);
	return {
		rawBytes: fileStat.size,
		gzipBytes: gzipSync(content).length,
	};
}

let hasError = false;

for (const budget of budgets) {
	const { rawBytes, gzipBytes } = await getFileSizes(budget);
	const label = budget.allAssets
		? `${budget.path}#all-assets`
		: budget.assetName ? `${budget.path}#${budget.assetName}` : budget.path;
	console.log(
		`${label}: raw ${formatBytes(rawBytes)} / budget ${formatBytes(budget.maxBytes)}, gzip ${formatBytes(gzipBytes)} / budget ${formatBytes(budget.maxGzipBytes)}`,
	);

	if (rawBytes > budget.maxBytes) {
		console.error(`${label} exceeds raw size budget by ${formatBytes(rawBytes - budget.maxBytes)}`);
		hasError = true;
	}

	if (gzipBytes > budget.maxGzipBytes) {
		console.error(`${label} exceeds gzip size budget by ${formatBytes(gzipBytes - budget.maxGzipBytes)}`);
		hasError = true;
	}
}

if (hasError) {
	process.exitCode = 1;
}
