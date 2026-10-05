import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { appendFile, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const deploymentFile = 'deployment.json';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

export async function siteFingerprint(directory) {
  const files = [];
  async function visit(relative = '') {
    for (const entry of await readdir(join(directory, relative), { withFileTypes: true })) {
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      if (path === deploymentFile) continue;
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) files.push([path, sha256(await readFile(join(directory, path)))]);
      else throw new Error(`Unsupported site entry: ${path}`);
    }
  }
  await visit();
  if (!files.length) throw new Error('Cannot deploy an empty website.');
  files.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  return sha256(JSON.stringify(files));
}

export async function prepareSiteDeployment({ directory, previousUrl, commit, force = false, request = fetch }) {
  const fingerprint = await siteFingerprint(directory);
  let previous = null;
  if (!force) {
    const url = new URL(previousUrl);
    url.searchParams.set('check', String(Date.now()));
    const response = await request(url, { cache: 'no-store', signal: AbortSignal.timeout(30000) });
    if (response.status !== 404) {
      if (!response.ok) throw new Error(`Cannot read deployed website fingerprint: HTTP ${response.status}`);
      previous = await response.json();
      if (previous?.format !== 1 || !/^[a-f0-9]{64}$/.test(previous.fingerprint ?? '')) {
        throw new Error('Invalid deployed website fingerprint. Use a manual deployment to replace it.');
      }
    }
  }
  const deploy = force || fingerprint !== previous?.fingerprint;
  await writeFile(join(directory, deploymentFile), `${JSON.stringify({ format: 1, fingerprint, commit }, null, 2)}\n`);
  return { deploy, fingerprint };
}

if (import.meta.main) {
  const result = await prepareSiteDeployment({
    directory: 'site', previousUrl: 'https://crate.kaanbiryol.com/deployment.json',
    commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    force: process.env.SITE_DEPLOY_FORCE === 'true',
  });
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `deploy=${result.deploy}\n`);
  console.log(result.deploy ? `Website changed or deployment forced: ${result.fingerprint}` : 'Website matches the last deployment; skipping publication.');
}
