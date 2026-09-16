import { build } from 'esbuild';
import { compile } from 'sass';
import { readFile, writeFile } from 'node:fs/promises';

// Reuse the PWA editor and its scoped styles in the local website example.
await build({
  entryPoints: ['site/assets/canvas-composer.js'],
  outfile: 'site/assets/canvas-composer.generated.js',
  bundle: true, format: 'esm', platform: 'browser', target: 'es2020', minify: true,
  define: { 'process.env.NODE_ENV': '"production"' },
  mainFields: ['browser', 'module', 'main'], conditions: ['browser', 'import'], legalComments: 'eof',
});
const palette = await Promise.all(['theme.css', 'reminders-view.css'].map(async (file) => {
  const css = await readFile(`src/cloudflare/worker/pwa/styles/${file}`, 'utf8');
  return css.match(/:root\s*\{([^}]+)\}/)[1];
}));
const styles = compile('site/website-options/canvas/composer.scss', { style: 'compressed', silenceDeprecations: ['legacy-js-api'] });
await writeFile('site/assets/canvas-composer.generated.css', `.canvas-composer{${palette.join('\n')}}\n${styles.css}`);
console.log('Canvas composer built from the shared PWA editor and pickers.');
