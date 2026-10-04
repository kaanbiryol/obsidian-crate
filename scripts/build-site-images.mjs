import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const site = new URL('../site/', import.meta.url);
const sources = await Promise.all(['index.html', 'assets/home.css'].map(path => readFile(new URL(path, site), 'utf8')));
const paths = [...new Set(sources.flatMap(source => [...source.matchAll(/\/assets\/screenshots\/lossless\/([a-z0-9-]+)\.webp/g)].map(match => match[1])))];
if (!paths.length) throw new Error('No lossless screenshot references found.');
await mkdir(new URL('assets/screenshots/lossless/', site), { recursive: true });
let inputBytes = 0;
let outputBytes = 0;
for (const name of paths) {
  const input = await readFile(new URL(`assets/screenshots/${name}.png`, site));
  const output = await sharp(input).webp({ lossless: true, effort: 4 }).toBuffer();
  const before = await sharp(input).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const after = await sharp(output).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  if (before.info.width !== after.info.width || before.info.height !== after.info.height || before.info.channels !== after.info.channels) {
    throw new Error(`${name}: lossless conversion changed image dimensions or channels.`);
  }
  for (let i = 0; i < before.data.length; i += 4) {
    // WebP may discard hidden RGB values under fully transparent pixels.
    // Alpha and every visible RGB value must remain identical.
    if (before.data[i + 3] !== after.data[i + 3] || (before.data[i + 3] !== 0 && (
      before.data[i] !== after.data[i] || before.data[i + 1] !== after.data[i + 1] || before.data[i + 2] !== after.data[i + 2]
    ))) throw new Error(`${name}: lossless conversion changed a visible pixel or transparency.`);
  }
  await writeFile(fileURLToPath(new URL(`assets/screenshots/lossless/${name}.webp`, site)), output);
  inputBytes += input.length;
  outputBytes += output.length;
}
console.log(`Verified ${paths.length} full-resolution lossless images: ${(inputBytes / 1048576).toFixed(2)} → ${(outputBytes / 1048576).toFixed(2)} MiB (${(100 * (1 - outputBytes / inputBytes)).toFixed(1)}% smaller).`);
