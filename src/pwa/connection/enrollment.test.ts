import { describe, expect, it } from 'vitest';
import { enrollmentTokenFromParams, urlWithoutEnrollmentTokens } from './enrollment';

describe('PWA enrollment token selection', () => {
	it('reserves the install token when Safari opens a two-token app link', () => {
		const params = new URLSearchParams('token=install-token&browserToken=browser-token');

		expect(enrollmentTokenFromParams(params, false)).toBe('browser-token');
		expect(enrollmentTokenFromParams(params, true)).toBe('install-token');
	});

	it.each(['token=install-token', 'token=install-token&browserToken=%20'])('requires a browser token without consuming the install token: %s', query => {
		const params = new URLSearchParams(query);
		expect(enrollmentTokenFromParams(params, false)).toBeNull();
		expect(enrollmentTokenFromParams(params, true)).toBe('install-token');
	});
});

describe('PWA enrollment URL cleanup', () => {
	it('keeps the reserved install grant in Safari while removing its browser grant', () => {
		expect(urlWithoutEnrollmentTokens({
			pathname: '/notifications',
			search: '?token=install-token&browserToken=browser-token&folder=Tasks&tab=today',
			hash: '#reminder',
		}, true)).toBe('/notifications?token=install-token&folder=Tasks&tab=today#reminder');
	});

	it('removes enrollment secrets while preserving navigation state', () => {
		expect(urlWithoutEnrollmentTokens({
			pathname: '/notifications',
			search: '?token=install-token&browserToken=browser-token&project=Work&tab=today',
			hash: '#reminder',
		})).toBe('/notifications?project=Work&tab=today#reminder');
	});

	it('leaves URLs without enrollment secrets unchanged', () => {
		expect(urlWithoutEnrollmentTokens({
			pathname: '/notifications',
			search: '?project=Work',
			hash: '',
		})).toBe('/notifications?project=Work');
	});
});
