import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, mock } from 'node:test';
import net from 'node:net';
import { createVisualTestRun, removeVisualRunOutputs } from './visual-test-run.mjs';

test('loading visual configuration needs no socket or run initialization', async () => {
  const previous = process.env.CRATE_VISUAL_TEST_RUN;
  delete process.env.CRATE_VISUAL_TEST_RUN;
  const listen = mock.method(net.Server.prototype, 'listen', () => { throw new Error('Config must not listen'); });
  try {
    const { default: config } = await import('../playwright.config.ts');
    assert.equal(config.testDir, './tests/visual');
    assert.equal(process.env.CRATE_VISUAL_TEST_RUN, undefined);
    assert.equal(listen.mock.callCount(), 0);
  } finally {
    listen.mock.restore();
    if (previous !== undefined) process.env.CRATE_VISUAL_TEST_RUN = previous;
  }
});

test('separate launchers allocate isolated runs without mutating their parent environment', async () => {
  const before = process.env.CRATE_VISUAL_TEST_RUN;
  const [first, second] = await Promise.all([createVisualTestRun(), createVisualTestRun()]);
  assert.notEqual(first.id, second.id);
  assert.notEqual(first.directory, second.directory);
  assert.notEqual(first.port, second.port);
  assert.equal(process.env.CRATE_VISUAL_TEST_RUN, before);
});

const exists = path => stat(path).then(() => true, () => false);
const outputs = (root, id) => [join(root, '.generated/visual-runs', id), join(root, 'test-results', `visual-${id}`), join(root, 'playwright-report', `visual-${id}`)];

test('removing a run deletes its snapshot, results and report but not another run', async t => {
  const root = await mkdtemp(join(tmpdir(), 'crate-visual-clean-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const id of ['finished', 'other']) for (const path of outputs(root, id)) {
    await mkdir(path, { recursive: true });
    await writeFile(join(path, 'file'), 'x');
  }
  await removeVisualRunOutputs({ id: 'finished', directory: outputs(root, 'finished')[0] }, root);
  for (const path of outputs(root, 'finished')) assert.equal(await exists(path), false, path);
  for (const path of outputs(root, 'other')) assert.equal(await exists(path), true, path);
});

// The launcher runs Playwright from node_modules relative to its working directory.
// A stand-in records the run, writes its output and exits with the requested status.
async function launch(t, status, env = {}) {
  const root = await mkdtemp(join(tmpdir(), 'crate-visual-launch-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'node_modules/@playwright/test'), { recursive: true });
  await writeFile(join(root, 'node_modules/@playwright/test/cli.js'), `
    const { mkdirSync, writeFileSync } = require('node:fs');
    const run = JSON.parse(process.env.CRATE_VISUAL_TEST_RUN);
    writeFileSync('run.json', JSON.stringify(run));
    for (const path of [run.directory, 'test-results/visual-' + run.id, 'playwright-report/visual-' + run.id]) {
      mkdirSync(path, { recursive: true });
      writeFileSync(path + '/file', 'x');
    }
    process.exit(${status});
  `);
  const { CI, ...inherited } = process.env;
  const child = spawn(process.execPath, [join(import.meta.dirname, 'visual-test-run.mjs')], { cwd: root, env: { ...inherited, ...env }, stdio: 'ignore' });
  const [code] = await once(child, 'exit');
  const { id } = JSON.parse(await readFile(join(root, 'run.json'), 'utf8'));
  return { code, kept: await Promise.all(outputs(root, id).map(exists)) };
}

test('a passing local run removes its own output', async t => {
  assert.deepEqual(await launch(t, 0), { code: 0, kept: [false, false, false] });
});

test('a failing run keeps its output for diagnosis', async t => {
  assert.deepEqual(await launch(t, 1), { code: 1, kept: [true, true, true] });
});

test('CI keeps passing output for artifact upload', async t => {
  assert.deepEqual(await launch(t, 0, { CI: 'true' }), { code: 0, kept: [true, true, true] });
});
