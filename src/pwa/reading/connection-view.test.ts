import { describe, expect, it } from 'vitest';
import { readingConnectionView, type ReadingConnectionInput } from './connection-view';

const connected: ReadingConnectionInput = { isOffline: false, readOnly: false, hasSession: true, hasCache: true, error: null, connectionState: 'available' };
const view = (patch: Partial<ReadingConnectionInput>) => readingConnectionView({ ...connected, ...patch });

describe('readingConnectionView', () => {
	it('lists the server library with no banner while connected', () => {
		expect(view({})).toEqual({ savedOnly: false, readingDisabled: false, connectionText: null, libraryError: null });
	});

	it('shows saved articles with an offline banner, also before the library loaded', () => {
		expect(view({ isOffline: true })).toMatchObject({ savedOnly: true, connectionText: 'Offline · showing saved articles', libraryError: null });
		expect(view({ isOffline: true, hasCache: false })).toMatchObject({ savedOnly: true, connectionText: 'Offline · showing saved articles' });
	});

	it('treats a library that never loaded on a reported-online network like being offline', () => {
		expect(view({ hasCache: false, error: 'Network request failed' }))
			.toMatchObject({ savedOnly: true, connectionText: 'Couldn’t connect · showing saved articles', libraryError: null });
	});

	it('names why an unanswered encryption check left the app read-only', () => {
		expect(view({ readOnly: true, error: 'The server took too long to answer' }))
			.toMatchObject({ savedOnly: true, connectionText: 'The server took too long to answer' });
		expect(view({ readOnly: true, error: null })).toMatchObject({ connectionText: 'Couldn’t connect · showing saved articles' });
	});

	it('shows no banner or saved list when no Reading folder is connected', () => {
		expect(view({ hasSession: false, hasCache: false, connectionState: 'unavailable', error: 'Choose a folder' }))
			.toEqual({ savedOnly: false, readingDisabled: true, connectionText: null, libraryError: null });
	});

	it('reports a library error only when no banner explains it', () => {
		expect(view({ hasSession: false, hasCache: false, error: 'Server error' })).toMatchObject({ readingDisabled: false, connectionText: null,
			libraryError: 'Your library is unavailable. Retry when connected.' });
	});
});
