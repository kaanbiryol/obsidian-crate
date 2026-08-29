import { stat } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { readFile } from 'node:fs/promises';

const budgetGroups = {
	plugin: [{
		path: 'dist/main.js',
		// Includes the compressed, integrity-checked Worker and PWA used by OAuth deployment.
		maxBytes: Number.parseInt(process.env.CRATE_MAIN_JS_BUDGET_BYTES ?? '1825000', 10),
		maxGzipBytes: Number.parseInt(process.env.CRATE_MAIN_JS_GZIP_BUDGET_BYTES ?? '905000', 10),
	},
	{
		path: 'dist/styles.css',
		// Owned selector prefixes and shared cross-host UI rules add raw bytes without materially affecting transfer size.
		maxBytes: Number.parseInt(process.env.CRATE_STYLES_BUDGET_BYTES ?? '381000', 10),
		maxGzipBytes: Number.parseInt(process.env.CRATE_STYLES_GZIP_BUDGET_BYTES ?? '45000', 10),
	}],
	worker: [{
		path: '.generated/cloudflare/worker.mjs',
		// The deployable Worker embeds the complete reminders PWA script.
		maxBytes: Number.parseInt(process.env.CRATE_WORKER_BUDGET_BYTES ?? '1430000', 10),
		maxGzipBytes: Number.parseInt(process.env.CRATE_WORKER_GZIP_BUDGET_BYTES ?? '615000', 10),
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

async function getFileSizes(path) {
	const [fileStat, content] = await Promise.all([stat(path), readFile(path)]);
	return {
		rawBytes: fileStat.size,
		gzipBytes: gzipSync(content).length,
	};
}

let hasError = false;

for (const budget of budgets) {
	const { rawBytes, gzipBytes } = await getFileSizes(budget.path);
	console.log(
		`${budget.path}: raw ${formatBytes(rawBytes)} / budget ${formatBytes(budget.maxBytes)}, gzip ${formatBytes(gzipBytes)} / budget ${formatBytes(budget.maxGzipBytes)}`,
	);

	if (rawBytes > budget.maxBytes) {
		console.error(`${budget.path} exceeds raw size budget by ${formatBytes(rawBytes - budget.maxBytes)}`);
		hasError = true;
	}

	if (gzipBytes > budget.maxGzipBytes) {
		console.error(`${budget.path} exceeds gzip size budget by ${formatBytes(gzipBytes - budget.maxGzipBytes)}`);
		hasError = true;
	}
}

if (hasError) {
	process.exitCode = 1;
}
