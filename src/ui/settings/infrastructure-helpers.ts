import type { DiagnosticResult } from '../../sync/diagnostics';

export interface DiagnosticSummary {
	failures: number;
	warnings: number;
}

export function summarizeDiagnosticResults(results: DiagnosticResult[]): DiagnosticSummary {
	return results.reduce<DiagnosticSummary>((summary, result) => {
		if (result.status === 'fail') {
			summary.failures += 1;
		} else if (result.status === 'warn') {
			summary.warnings += 1;
		}
		return summary;
	}, {
		failures: 0,
		warnings: 0,
	});
}

export function getDiagnosticsNoticeMessage(summary: DiagnosticSummary): string {
	if (summary.failures === 0 && summary.warnings === 0) {
		return 'Diagnostics passed';
	}

	return `Diagnostics complete: ${summary.failures} fail, ${summary.warnings} warn`;
}

export function getDiagnosticStatusPrefix(status: DiagnosticResult['status']): string {
	if (status === 'pass') {
		return 'PASS';
	}
	if (status === 'warn') {
		return 'WARN';
	}
	return 'FAIL';
}
