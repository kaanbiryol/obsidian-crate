import assert from 'node:assert/strict';
import { test, mock } from 'node:test';
import net from 'node:net';
import { createVisualTestRun } from './visual-test-run.mjs';

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
