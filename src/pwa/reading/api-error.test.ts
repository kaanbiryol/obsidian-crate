import { afterEach, expect, it, vi } from 'vitest';
import { readingRequest } from './api';
import { ReadingApiError, readingConnectionState } from './api-error';
afterEach(() => vi.unstubAllGlobals());
it('retains server error codes and classifies state independently of copy', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'Different copy', code: 'reading_not_configured' }), { status: 403 })));
  const error = await readingRequest('/reading/session', null).catch((error: unknown) => error);
  expect(error).toBeInstanceOf(ReadingApiError);
  expect(readingConnectionState(error)).toBe('not-configured');
  expect(readingConnectionState(new ReadingApiError('Different copy', 423, 'feature_paused'))).toBe('paused');
});
it('supports older generic errors without classifying unrelated failures as disabled', () => {
  expect(readingConnectionState(new ReadingApiError('Choose a Reading folder in Obsidian’s Crate settings first.', 403, 'reading_error'))).toBe('not-configured');
  expect(readingConnectionState(new ReadingApiError('Unauthorized', 401))).toBe('available');
  expect(readingConnectionState(new Error('Reading is disabled. Enable it in Crate settings.'))).toBe('available');
});
