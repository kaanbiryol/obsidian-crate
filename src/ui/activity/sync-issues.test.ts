import { afterEach, expect, it, vi } from 'vitest';
import { FakeElement } from '../../test/fakes/obsidian-ui';
import { renderSyncIssues } from './sync-issues';
import { explainSyncIssue } from './sync-issue-message';

afterEach(() => vi.unstubAllGlobals());

it.each([
  ['Unsupported reminder description encoding on line 12', 'unsupported format', 'crate-desc'],
  ['Invalid reminder description encoding on line 2', 'could not be read', 'Source mode'],
  ['Skipped local file larger than 25MB', 'size limit', 'exclude'],
  ['ENOSPC', 'storage space', 'Free space'],
  ['EACCES', 'could not access', 'permissions'],
  ['ERR_NAME_NOT_RESOLVED', 'reach the sync server', 'server address'],
  ['Sync connection changed during reminder setup', 'server could not complete', 'connection'],
  ['Remote deletion deferred until uploads finish', 'deletion is waiting', 'other listed errors'],
  ['Upload journal belongs to another server', 'recovering a previous sync', 'intact'],
])('explains %s and gives a recovery step', (message, summary, recovery) => {
  const result = explainSyncIssue({ message, path: 'notes/a.md' });
  expect(result.summary).toContain(summary);
  expect(result.recovery).toContain(recovery);
  if (message.includes('on line')) expect(result.summary).toContain(message.match(/line \d+/)![0]);
});

it('opens the explicit file and keeps technical details copyable as text', async () => {
  const container = new FakeElement('div');
  const path = 'Notes/café: <img src=x>.md';
  const run = vi.fn(async () => {});
  const fileActions = vi.fn(() => [{ id: 'open' as const, title: 'Open in Obsidian', icon: 'file', run }]);
  const writeText = vi.fn(async () => {});
  vi.stubGlobal('navigator', { clipboard: { writeText } });
  renderSyncIssues(container as unknown as HTMLElement, [{ path, message: 'EACCES' }], { fileActions });
  expect(fileActions).toHaveBeenCalledWith(path);
  expect(container.querySelector('strong')!.textContent).toBe(path);
  expect(container.querySelector('img')).toBeNull();
  const actions = container.querySelector('.crate-sync-issue-actions')!;
  actions.children[0]!.dispatchEvent(new Event('click'));
  await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
  actions.children[1]!.dispatchEvent(new Event('click'));
  await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith(expect.stringContaining(`${path}: EACCES`)));
});

it('keeps moved files and clipboard failures actionable without replacing the error', async () => {
  const container = new FakeElement('div');
  vi.stubGlobal('navigator', {});
  renderSyncIssues(container as unknown as HTMLElement, [{ path: 'moved.md', message: 'EACCES' }], {
    fileActions: () => [{ id: 'open', title: 'Open', icon: 'file', run: async () => { throw new Error('missing'); } }],
  });
  const actions = container.querySelector('.crate-sync-issue-actions')!;
  actions.children[0]!.dispatchEvent(new Event('click'));
  await vi.waitFor(() => expect(container.collectText()).toContain('It may have moved'));
  actions.children[1]!.dispatchEvent(new Event('click'));
  await vi.waitFor(() => expect(container.collectText()).toContain('copy them manually'));
  expect(container.querySelector('pre')!.textContent).toBe('EACCES');
});

it('never offers an action for unsafe paths or invents file context for global failures', () => {
  const container = new FakeElement('div');
  const fileActions = vi.fn(() => []);
  renderSyncIssues(container as unknown as HTMLElement, [
    { path: '../outside.md', message: 'error' }, { message: 'note.md: request failed' },
  ], { fileActions });
  expect(fileActions).not.toHaveBeenCalled();
  expect(container.collectText()).toContain('Technical details');
});

it('keeps the error review usable if a server path cannot be accessed on this device', () => {
  const container = new FakeElement('div');
  renderSyncIssues(container as unknown as HTMLElement, [{ path: 'AUX.md', message: 'invalid filename' }], {
    fileActions: () => { throw new Error('invalid on Windows'); },
  });
  expect(container.collectText()).toContain('AUX.md');
  expect(container.collectText()).toContain('Copy details');
});
