import { build } from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';

const { outputFiles } = await build({ entryPoints: ['src/cloudflare/worker/reading/save-page.ts'], bundle: true,
  platform: 'node', format: 'esm', write: false, minify: false });
const { readingSavePage, readingSaveScript } = await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString('base64')}`);
const directory = 'site/shortcuts/help';
await mkdir(directory, { recursive: true });
await writeFile(`${directory}/index.html`, await readingSavePage({ supportOnly: true, scriptUrl: './support.js' }).text());
await writeFile(`${directory}/support.js`, await readingSaveScript({ supportOnly: true }).text());
console.log(`Shortcut support page written to ${directory}`);
