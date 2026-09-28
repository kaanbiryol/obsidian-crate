import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { runProcess } from './local-server-process.mjs';

// Official release assets. Pin both version and SHA-256; never execute a
// download based only on a mutable "latest" URL or an unverified API response.
export const cloudflaredVersion = '2026.9.3';
const assets = {
	'darwin-arm64': ['cloudflared-darwin-arm64.tgz', '587c2cfb1c230fe36c7fa7727da78be459dae028cabe8c001291999350f07095'],
	'darwin-x64': ['cloudflared-darwin-amd64.tgz', 'd1155d0837487f261183b15c1eab6c4ebcad9dc49b94675f1524c3564cea3977'],
	'linux-x64': ['cloudflared-linux-amd64', '77e26d8d900e0b8469f416239d14b5f296525fdf79fee6f511ef55609e3fbac2'],
	'linux-arm64': ['cloudflared-linux-arm64', 'aaeb2d7d0da3614634c7e03ab13487a1522c2e79165ed2929cfe23d5e95b326d'],
	'win32-x64': ['cloudflared-windows-amd64.exe', 'f096265ec2fcbe9bb6e2d64268db167ced3fcbb83d894bdb9e2fcdb26f2ea7e2'],
};
const hash = data => createHash('sha256').update(data).digest('hex');

export function extractCloudflared(archive) {
	const tar = gunzipSync(archive, { maxOutputLength: 100 * 1024 * 1024 });
	for (let offset = 0; offset + 512 <= tar.length;) {
		const name = tar.subarray(offset, offset + 100).toString().replace(/\0.*$/s, '');
		const sizeText = tar.subarray(offset + 124, offset + 136).toString().replace(/\0.*$/s, '').trim();
		if (!name) break;
		if (!/^[0-7]+$/.test(sizeText)) throw new Error('Invalid cloudflared archive size.');
		const size = parseInt(sizeText, 8);
		if (offset + 512 + size > tar.length) throw new Error('Truncated cloudflared archive.');
		if (['cloudflared', './cloudflared'].includes(name) && [0, 48].includes(tar[offset + 156])) {
			return tar.subarray(offset + 512, offset + 512 + size);
		}
		offset += 512 + Math.ceil(size / 512) * 512;
	}
	throw new Error('Cloudflared executable is missing from its release archive.');
}

export async function installCloudflared({ signal, platform = process.platform, arch = process.arch,
	cacheDir = join(homedir(), '.crate', 'bin'), fetchAsset = fetch, run = runProcess } = {}) {
	try { await run('cloudflared', ['--version'], { signal, stdio: 'ignore' }); return 'cloudflared'; }
	catch (error) { if (error.code !== 'ENOENT') throw error; }
	const asset = assets[`${platform}-${arch}`];
	if (!asset) throw new Error(`Automatic cloudflared installation is unavailable for ${platform}/${arch}. Install cloudflared yourself and retry.`);
	const [filename, sha256] = asset;
	const directory = join(cacheDir, cloudflaredVersion, `${platform}-${arch}`);
	await mkdir(directory, { recursive: true, mode: 0o700 });
	const archivePath = join(directory, filename + '.download');
	let archive = await readFile(archivePath).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
	if (!archive || hash(archive) !== sha256) {
		console.log(`Downloading cloudflared ${cloudflaredVersion} from Cloudflare's GitHub release...`);
		const response = await fetchAsset(`https://github.com/cloudflare/cloudflared/releases/download/${cloudflaredVersion}/${filename}`,
			{ signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(120_000)]) : AbortSignal.timeout(120_000) });
		if (!response.ok) throw new Error(`Could not download cloudflared (HTTP ${response.status}). Retry when internet access is available.`);
		archive = Buffer.from(await response.arrayBuffer());
		if (hash(archive) !== sha256) throw new Error('Cloudflared checksum mismatch. The download was not installed or executed.');
		await writeFile(archivePath, archive, { mode: 0o600 });
	}
	signal?.throwIfAborted();
	const binary = filename.endsWith('.tgz') ? extractCloudflared(archive) : archive;
	const command = join(directory, platform === 'win32' ? 'cloudflared.exe' : 'cloudflared');
	const existing = await readFile(command).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
	if (!existing || hash(existing) !== hash(binary)) {
		const temporary = `${command}.${randomUUID()}.tmp`;
		try { await writeFile(temporary, binary, { flag: 'wx', mode: 0o700 }); await rename(temporary, command); }
		finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
	}
	await chmod(command, 0o700);
	return command;
}
