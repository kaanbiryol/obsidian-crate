import { describe, expect, it } from 'vitest';
import {
	getDiagnosticStatusPrefix,
	getDiagnosticsNoticeMessage,
	inferWorkerNameFromUrl,
	summarizeDiagnosticResults,
} from './infrastructure-helpers';

describe('inferWorkerNameFromUrl', () => {
	it('extracts the worker subdomain from workers.dev URLs', () => {
		expect(inferWorkerNameFromUrl(' https://crate-sync.workers.dev/api/sync ')).toBe('crate-sync');
	});

	it('returns null for non-workers.dev hosts or invalid URLs', () => {
		expect(inferWorkerNameFromUrl('https://example.com')).toBeNull();
		expect(inferWorkerNameFromUrl('not a url')).toBeNull();
		expect(inferWorkerNameFromUrl('')).toBeNull();
	});
});

describe('diagnostic helpers', () => {
	it('counts failures and warnings and formats the notice message', () => {
		const summary = summarizeDiagnosticResults([
			{ name: 'Worker', message: 'reachable', status: 'pass' },
			{ name: 'Bucket', message: 'missing', status: 'fail' },
			{ name: 'Database', message: 'stale', status: 'warn' },
			{ name: 'Auth', message: 'bad token', status: 'fail' },
		]);

		expect(summary).toEqual({
			failures: 2,
			warnings: 1,
		});
		expect(getDiagnosticsNoticeMessage(summary)).toBe('Diagnostics complete: 2 fail, 1 warn');
	});

	it('reports a clean diagnostics pass without warnings or failures', () => {
		const summary = summarizeDiagnosticResults([
			{ name: 'Worker', message: 'reachable', status: 'pass' },
		]);

		expect(getDiagnosticsNoticeMessage(summary)).toBe('Diagnostics passed');
	});

	it('maps diagnostic statuses to stable row prefixes', () => {
		expect(getDiagnosticStatusPrefix('pass')).toBe('PASS');
		expect(getDiagnosticStatusPrefix('warn')).toBe('WARN');
		expect(getDiagnosticStatusPrefix('fail')).toBe('FAIL');
	});
});
