import { readdir, stat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Encodes the full-quality recordings in site/assets/videos/originals/ into the
// H.264 files the homepage serves. Resolution and frame rate stay as recorded.
// Few reference frames keep hardware decoders (Safari, Chrome on macOS) within
// the H.264 level limits, which avoids smeared blocks during fades.
const videos = new URL('../site/assets/videos/', import.meta.url);
const originals = new URL('originals/', videos);

function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  if (result.error) throw new Error(`${command} is required to build homepage videos: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`${command} failed:\n${result.stderr}`);
  return result.stdout;
}

function probe(path) {
  const [width, height, frames] = run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-count_packets',
    '-show_entries', 'stream=width,height,nb_read_packets', '-of', 'csv=p=0', path]).trim().split(',').map(Number);
  return { width, height, frames };
}

const names = (await readdir(originals)).filter(name => /\.(mp4|mov)$/i.test(name));
if (!names.length) throw new Error('No originals found in site/assets/videos/originals/.');
let inputBytes = 0;
let outputBytes = 0;
for (const name of names) {
  const input = fileURLToPath(new URL(name, originals));
  const output = fileURLToPath(new URL(name.replace(/\.(mp4|mov)$/i, '.mp4'), videos));
  run('ffmpeg', ['-v', 'error', '-y', '-i', input, '-an', '-c:v', 'libx264', '-preset', 'slow', '-crf', '16',
    '-profile:v', 'high', '-x264-params', 'ref=3:bframes=3', '-pix_fmt', 'yuv420p',
    '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709', '-movflags', '+faststart', output]);
  const before = probe(input);
  const after = probe(output);
  if (before.width !== after.width || before.height !== after.height || before.frames !== after.frames) {
    throw new Error(`${name}: encoding changed the size or frame count (${JSON.stringify(before)} → ${JSON.stringify(after)}).`);
  }
  const [inSize, outSize] = await Promise.all([stat(input), stat(output)]).then(files => files.map(file => file.size));
  inputBytes += inSize;
  outputBytes += outSize;
  console.log(`${name}: ${after.width}×${after.height}, ${after.frames} frames, ${(inSize / 1048576).toFixed(2)} → ${(outSize / 1048576).toFixed(2)} MiB`);
}
console.log(`Encoded ${names.length} videos: ${(inputBytes / 1048576).toFixed(2)} → ${(outputBytes / 1048576).toFixed(2)} MiB. Bump each changed video's ?v= in site/index.html.`);
