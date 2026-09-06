import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const version = '8.30.1';
const platform = { darwin: 'darwin', linux: 'linux' }[process.platform];
const arch = { arm64: 'arm64', x64: 'x64' }[process.arch];
const hashes = {
	'darwin_arm64': 'b40ab0ae55c505963e365f271a8d3846efbc170aa17f2607f13df610a9aeb6a5',
	'darwin_x64': 'dfe101a4db2255fc85120ac7f3d25e4342c3c20cf749f2c20a18081af1952709',
	'linux_arm64': 'e4a487ee7ccd7d3a7f7ec08657610aa3606637dab924210b3aee62570fb4b080',
	'linux_x64': '551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb',
};
const expected = hashes[`${platform}_${arch}`];
if (!expected) throw new Error('Secret scanning requires Linux or macOS on x64 or arm64');
const temporary = mkdtempSync(join(tmpdir(), 'crate-secrets-'));
try {
	const asset = `gitleaks_${version}_${platform}_${arch}.tar.gz`;
	const response = await fetch(`https://github.com/gitleaks/gitleaks/releases/download/v${version}/${asset}`, { signal: AbortSignal.timeout(60_000) });
	if (!response.ok) throw new Error(`Could not download pinned Gitleaks: ${response.status}`);
	const bytes = Buffer.from(await response.arrayBuffer());
	if (createHash('sha256').update(bytes).digest('hex') !== expected) throw new Error('Gitleaks checksum mismatch');
	const archive = join(temporary, asset);
	writeFileSync(archive, bytes);
	execFileSync('tar', ['-xzf', archive, '-C', temporary, 'gitleaks']);
	const binary = join(temporary, 'gitleaks');
	const config = resolve('.gitleaks.toml');
	const common = ['--redact', '--no-banner', '--config', config, '--gitleaks-ignore-path', resolve('.gitleaksignore')];
	function scan(args, name) {
		const report = resolve('.generated/security', `gitleaks-${name}.json`);
		mkdirSync(dirname(report), { recursive: true });
		try { execFileSync(binary, [...args, ...common, '--report-format', 'json', '--report-path', report], { stdio: 'inherit' }); }
		catch (error) {
			if (error.status === 1) {
				for (const finding of JSON.parse(readFileSync(report, 'utf8'))) console.error(JSON.stringify({ rule: finding.RuleID, file: finding.File, line: finding.StartLine, commit: finding.Commit, fingerprint: finding.Fingerprint }));
			}
			throw error;
		}
	}
	scan(['git', '.', '--log-opts=--all'], 'history');
	// Include pending source edits without traversing ignored dependencies,
	// generated bundles, private local configuration, or unrelated directories.
	const source = join(temporary, 'source');
	mkdirSync(source);
	const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
	for (const file of new Set(files)) {
		const target = join(source, file);
		mkdirSync(dirname(target), { recursive: true });
		try { copyFileSync(file, target); } catch (error) { if (error.code !== 'ENOENT') throw error; }
	}
	scan(['dir', source], 'source');
	console.log(`Gitleaks ${version}: history and current source passed`);
} finally { rmSync(temporary, { recursive: true, force: true }); }
