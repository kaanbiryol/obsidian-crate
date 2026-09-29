import { build } from 'esbuild';
import { readFile, writeFile } from 'node:fs/promises';

const { outputFiles } = await build({
	stdin: { contents: `export { CRATE_PLUGIN_PROTOCOL as protocol } from './src/protocol';
		export { default as release } from './src/cloudflare/server-release.json';
		export * as limits from './src/protocol/sync-limits';`, resolveDir: process.cwd() },
	bundle: true, platform: 'node', format: 'esm', write: false,
});
const { protocol, release, limits } = await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString('base64')}`);
const text = `# Current release contract

Generated from the release manifest, wire protocol and shared transfer limits.
Run \`node scripts/check-contract-docs.mjs --write\` after changing those contracts;
\`npm run check:contracts\` rejects stale values.

| Contract | Current value |
| --- | --- |
| Server candidate revision | ${release.revision} |
| Fresh database schema | ${release.schemaVersion} |
| Oldest supported database schema | ${release.minimumSchemaVersion} |
| Wire protocol | ${protocol.current} |
| Oldest compatible wire protocol | ${protocol.oldestCompatible} |
| Registered migrations | ${release.migrations.map(item => `\`${item.id}\` (${item.from} → ${item.to})`).join(', ') || 'None'} |
| Markdown upload batch | ${limits.BATCH_UPLOAD_MAX_FILES} files |
| Asset upload batch | ${limits.BATCH_ASSET_UPLOAD_MAX_FILES} files |
| New-file import batch | ${limits.BULK_NEW_UPLOAD_MAX_FILES} files |
| Delete batch | ${limits.BATCH_DELETE_MAX_FILES} files |
| Download batch | ${limits.BATCH_DOWNLOAD_MAX_FILES} files |
| Upload batch bytes | ${limits.BATCH_UPLOAD_MAX_BYTES} |
| Download batch bytes | ${limits.BATCH_DOWNLOAD_MAX_BYTES} |
| Largest file | ${limits.MAX_FILE_SIZE_BYTES} bytes |

Schema-1 databases in the current migration chain upgrade through the registered
migration. Databases from the retired pre-reset development sequence require
their matching old build and recovery instructions; matching numbers alone do
not establish compatibility. See [server upgrades](server-upgrades.md),
[compatibility](compatibility.md), and [recovery](recovery.md).
`;
const path = 'docs/current-contract.md';
if (process.argv.includes('--write')) await writeFile(path, text);
else if (await readFile(path, 'utf8') !== text) throw new Error(`Stale ${path}. Run node scripts/check-contract-docs.mjs --write.`);
console.log(`${path}: ${process.argv.includes('--write') ? 'updated' : 'matches source'}`);
