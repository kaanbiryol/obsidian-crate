import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// Last committed editor before the Lexical migration. Pinning this makes the
// comparison repeatable even after the migration itself is committed.
const baselineRef = process.env.EDITOR_BASELINE_REF ?? '4ac503fa54ba36aa54b8a64d916db65dc008bae0';
const mode = process.argv[2] ?? 'compare';
if (!['baseline', 'current', 'compare'].includes(mode)) throw new Error('Use baseline, current or compare');
const root = process.cwd();
const reports = resolve('.generated/editor-contract');
mkdirSync(reports, { recursive: true });
const baseline = mode === 'current' ? baselineRef : execFileSync('git', ['rev-parse', '--verify', '--end-of-options', `${baselineRef}^{commit}`], { encoding: 'utf8' }).trim();

function run(name, directory) {
  const output = join(reports, name);
  rmSync(output, { recursive: true, force: true });
  const result = spawnSync(process.execPath, ['node_modules/@playwright/test/cli.js', 'test', '--config', 'tests/editor-contract/playwright.config.ts'], {
    cwd: root, stdio: 'inherit', env: { ...process.env, EDITOR_CONTRACT_ROOT: directory, EDITOR_CONTRACT_OUTPUT: output },
  });
  if (result.error) throw result.error;
  if (result.signal) throw new Error(`${name} interrupted: ${result.signal}`);
  const pwa = spawnSync(process.execPath, ['scripts/pwa-editor-contract-test.mjs'], {
    cwd: directory, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, env: process.env,
  });
  if (pwa.error) throw pwa.error;
  writeFileSync(join(output, 'pwa.log'), pwa.stdout + pwa.stderr);
  console.log(pwa.stdout);
  if (pwa.status !== 0) console.error(pwa.stderr);
  writeFileSync(join(output, 'pwa.json'), JSON.stringify({ status: pwa.status, signal: pwa.signal }));
  return (result.status ?? 1) || (pwa.status ?? 1);
}
let oldStatus = 0;
let newStatus = 0;
if (mode !== 'current') {
  const directory = mkdtempSync(join(tmpdir(), 'crate-editor-baseline-'));
  const archive = execFileSync('git', ['archive', '--format=tar', baseline], { maxBuffer: 64 * 1024 * 1024 });
  execFileSync('tar', ['-x', '-C', directory], { input: archive });
  symlinkSync(join(root, 'node_modules'), join(directory, 'node_modules'), 'dir');
  cpSync(join(root, 'tests/editor-contract'), join(directory, 'tests/editor-contract'), { recursive: true });
  for (const file of ['pwa-editor-contract-test.mjs', 'pwa-preview-fixtures.mjs']) {
    cpSync(join(root, 'scripts', file), join(directory, 'scripts', file));
  }
  writeFileSync(join(reports, 'baseline.json'), JSON.stringify({ commit: baseline, directory, dependencySource: root }, null, 2));
  console.log(`Testing unchanged baseline ${baseline} in ${directory}`);
  oldStatus = run('baseline', directory);
}
if (mode !== 'baseline') newStatus = run('current', root);
if (mode === 'compare') {
  const cases = name => {
    const report = JSON.parse(readFileSync(join(reports, name, 'results.json'), 'utf8'));
    const entries = [];
    const walk = suites => { for (const suite of suites) {
      for (const spec of suite.specs ?? []) for (const test of spec.tests) entries.push([`${test.projectName}: ${spec.title}`, test.status]);
      walk(suite.suites ?? []);
    } };
    walk(report.suites);
    return new Map(entries);
  };
  const old = cases('baseline');
  const current = cases('current');
  const comparison = [...new Set([...old.keys(), ...current.keys()])].map(name => ({ name, baseline: old.get(name) ?? 'missing', current: current.get(name) ?? 'missing' }));
  const regressions = comparison.filter(test => test.baseline === 'expected' && test.current !== 'expected');
  const improvements = comparison.filter(test => test.baseline !== 'expected' && test.current === 'expected');
  const existingFailures = comparison.filter(test => test.baseline !== 'expected' && test.current !== 'expected');
  const pwa = Object.fromEntries(['baseline', 'current'].map(name => [name, JSON.parse(readFileSync(join(reports, name, 'pwa.json'), 'utf8'))]));
  const summary = { baseline, cases: comparison.length, regressions, improvements, existingFailures, pwa };
  writeFileSync(join(reports, 'comparison.json'), JSON.stringify({ ...summary, results: comparison }, null, 2));
  const lines = ['# Editor compatibility comparison', '', `Baseline: ${baseline}`, '',
    `- Cases: ${comparison.length}`, `- Regressions: ${regressions.length}`, `- Improvements: ${improvements.length}`,
    `- Existing failures: ${existingFailures.length}`, `- Built PWA baseline/current exit codes: ${pwa.baseline.status}/${pwa.current.status}`, '',
    '| Browser / host / behavior | Old editor | Current editor |', '| --- | --- | --- |',
    ...comparison.map(test => `| ${test.name.replaceAll('|', '\\|').replaceAll('\n', ' ')} | ${test.baseline === 'expected' ? 'Pass' : test.baseline} | ${test.current === 'expected' ? 'Pass' : test.current} |`)];
  writeFileSync(join(reports, 'comparison.md'), lines.join('\n') + '\n');
  console.log(JSON.stringify(summary, null, 2));
  // Existing baseline defects stay visible in the report; they do not make a
  // passing current implementation fail. A missing case is always an error.
  if (!comparison.length || regressions.length || existingFailures.length
    || comparison.some(test => test.baseline === 'missing' || test.current === 'missing')) newStatus = 1;
}
process.exitCode = mode === 'baseline' ? oldStatus : newStatus;
