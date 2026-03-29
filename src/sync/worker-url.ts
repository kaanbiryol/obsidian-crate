import { createLogger } from '../plugin/logger';

const logger = createLogger('WorkerUrl');

export function normalizeWorkerUrl(workerUrl: string): string {
	const raw = workerUrl.trim();
	if (!raw) {
		return '';
	}

	try {
		const parsed = new URL(raw);
		const hostname = parsed.hostname.replace(/^\[(.*)\]$/, '$1');
		const isLocalhost = ['localhost', '127.0.0.1', '::1'].includes(hostname);
		const isSecure = parsed.protocol === 'https:' || (parsed.protocol === 'http:' && isLocalhost);
		if (!isSecure) {
			logger.warn(`Rejected worker URL with insecure protocol: ${parsed.protocol}`);
			return '';
		}
		return parsed.toString().replace(/\/$/, '');
	} catch {
		logger.warn('Rejected invalid worker URL');
		return '';
	}
}

export function requireNormalizedWorkerUrl(workerUrl: string): string {
	const normalized = normalizeWorkerUrl(workerUrl);
	if (!normalized) {
		throw new Error('Worker URL must use HTTPS (or localhost over HTTP) and be a valid URL');
	}
	return normalized;
}
