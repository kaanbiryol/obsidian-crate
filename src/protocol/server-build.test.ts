import { expect, it } from 'vitest';
import { canReplaceServerBuild, parseDevelopmentBuild, serverBuildLabel } from './server-build';

const worker = `crate-${'a'.repeat(16)}`;
const stable = { revision: 3, fingerprint: 'stable' };
const dev = (number: number) => ({ revision: 3, fingerprint: `dev-${number}`, development: { number, worker } });

it('orders development updates and promotion while preserving stable immutability', () => {
  expect(canReplaceServerBuild({ ...stable, revision: 2 }, dev(1))).toBe(true);
  expect(canReplaceServerBuild(dev(1), dev(10))).toBe(true);
  expect(canReplaceServerBuild(dev(10), stable)).toBe(true);
  expect(canReplaceServerBuild(stable, dev(11))).toBe(false);
  expect(canReplaceServerBuild(stable, { ...stable, fingerprint: 'changed' })).toBe(false);
  expect(canReplaceServerBuild(dev(10), dev(9))).toBe(false);
  expect(canReplaceServerBuild(dev(10), { ...dev(10), fingerprint: 'changed' })).toBe(false);
  expect(canReplaceServerBuild(dev(10), dev(10))).toBe(true);
  expect(canReplaceServerBuild(dev(10), { ...stable, revision: 2 })).toBe(false);
  expect(canReplaceServerBuild(dev(1), { ...dev(2), development: { number: 2, worker: `crate-${'b'.repeat(16)}` } })).toBe(false);
});

it('validates bounded development identities and displays the release label', () => {
  for (const value of [null, {}, { number: -1, worker }, { number: 1.5, worker }, { number: 1, worker: '*' }]) expect(parseDevelopmentBuild(value)).toBeUndefined();
  expect(parseDevelopmentBuild({ number: 10, worker })).toEqual({ number: 10, worker });
  expect(serverBuildLabel(3, { number: 10, worker })).toBe('3-dev.10');
  expect(serverBuildLabel(3)).toBe('3');
});
