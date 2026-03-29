import { stat } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { readFile } from 'node:fs/promises';

const budgets = [
	{
		path: 'dist/main.js',
		maxBytes: Number.parseInt(process.env.CRATE_MAIN_JS_BUDGET_BYTES ?? '1050000', 10),
		maxGzipBytes: Number.parseInt(process.env.CRATE_MAIN_JS_GZIP_BUDGET_BYTES ?? '300000', 10),
	},
	{
		path: 'dist/styles.css',
		maxBytes: Number.parseInt(process.env.CRATE_STYLES_BUDGET_BYTES ?? '320000', 10),
		maxGzipBytes: Number.parseInt(process.env.CRATE_STYLES_GZIP_BUDGET_BYTES ?? '45000', 10),
	},
];

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
