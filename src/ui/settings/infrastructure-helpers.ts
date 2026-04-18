import type { DiagnosticResult } from '../../cloudflare/infrastructure';

export interface DiagnosticSummary {
	failures: number;
	warnings: number;
}

export function inferWorkerNameFromUrl(workerUrl: string): string | null {
	const normalized = workerUrl.trim();
	if (!normalized) {
		return null;
	}

	try {
		const parsed = new URL(normalized);
		const hostname = parsed.hostname.toLowerCase();
		if (!hostname.endsWith('.workers.dev')) {
			return null;
		}
		const parts = hostname.split('.');
		if (parts.length < 3) {
			return null;
		}
		return parts[0] ?? null;
	} catch {
		return null;
	}
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
