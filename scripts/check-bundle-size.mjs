import { stat } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { readFile } from 'node:fs/promises';

import { bundleBudgets as budgetGroups } from './bundle-budgets.mjs';

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
	if (budget.assetName || budget.allAssets || budget.startupAssets) {
		const payload = JSON.parse(await readFile(path, 'utf-8'));
		const assets = payload?.assets;
		if (!assets || typeof assets !== 'object') throw new Error(`Missing PWA assets in ${path}`);
		if (budget.startupAssets && (!Array.isArray(payload.startupAssets) || !payload.startupAssets.includes('app.js'))) {
			throw new Error(`Missing PWA startup dependency graph in ${path}`);
		}
		const sources = budget.allAssets ? Object.values(assets)
			: budget.startupAssets ? payload.startupAssets.map(name => assets[name]) : [assets[budget.assetName]];
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
		: budget.startupAssets ? `${budget.path}#startup-assets`
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
