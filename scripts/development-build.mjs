import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadEnv } from 'vite';

export function createDevelopmentBuild(root, worker = loadEnv('development', root, 'CRATE_DEV_WORKER').CRATE_DEV_WORKER) {
  if (!/^crate-[a-f0-9]{16}$/.test(worker ?? '')) throw new Error('Set CRATE_DEV_WORKER in .env.development.local or your shell to the exact Worker name of your development server (crate- followed by 16 hex characters).');
  const { revision } = JSON.parse(readFileSync(resolve(root, 'src/cloudflare/server-release.json'), 'utf8'));
  if (!Number.isSafeInteger(revision) || revision < 1) throw new Error('Invalid public server revision');
  const path = resolve(root, 'server-development.local.json');
  let previous = 0;
  try {
    const { version } = JSON.parse(readFileSync(path, 'utf8'));
    const match = typeof version === 'string' && /^([1-9]\d*)-dev\.(0|[1-9]\d*)$/.exec(version);
    if (!match || !Number.isSafeInteger(Number(match[1])) || !Number.isSafeInteger(Number(match[2]))) throw new Error('Invalid local development version');
    // Each public revision has its own development sequence.
    previous = Number(match[1]) === revision ? Number(match[2]) : 0;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const number = previous + 1;
  if (!Number.isSafeInteger(number)) throw new Error('Development build counter exhausted');
  writeFileSync(path, `${JSON.stringify({ version: `${revision}-dev.${number}` }, null, 2)}\n`);
  return { number, worker };
}

export function readBuiltIdentity(root) {
  const identity = JSON.parse(readFileSync(resolve(root, '.generated/cloudflare/build-identity.json'), 'utf8'));
  const digest = createHash('sha256').update(readFileSync(resolve(root, '.generated/cloudflare/worker.mjs'))).digest('hex');
  const release = JSON.parse(readFileSync(resolve(root, 'src/cloudflare/server-release.json'), 'utf8'));
  if (identity.workerSha256 !== digest || JSON.stringify(identity.release) !== JSON.stringify(release)) throw new Error('Worker build identity is stale. Rebuild the Worker first.');
  return identity;
}
