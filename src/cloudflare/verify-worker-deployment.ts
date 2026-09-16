import { CRATE_SERVICE_ID } from '../protocol';
import release from './server-release.json';
import type { HttpTransport } from './http';

/** Wait for the public route to serve the uploaded build, without repeating mutations. */
export async function verifyWorkerDeployment(transport: HttpTransport, origin: string, fingerprint: string, published = false): Promise<{ revision: number; schemaVersion: number }> {
	let observed = '';
	for (let attempt = 0; attempt < 8; attempt++) {
		// Never forward management credentials to the public Worker.
		const response = await transport(`${origin}/.well-known/crate`, {
			method: 'GET', headers: { 'Cache-Control': 'no-cache' },
		});
		let info: Record<string, unknown> | null = null;
		try {
			const parsed: unknown = JSON.parse(response.text);
			if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) info = parsed as Record<string, unknown>;
		} catch { /* A newly enabled route may temporarily return an HTML error page. */ }
		if (response.status === 200 && info?.service === CRATE_SERVICE_ID
			&& info.deploymentFingerprint === fingerprint
			&& (published ? Number.isSafeInteger(info.serverRevision) && Number(info.serverRevision) > 0 && Number(info.serverRevision) <= release.revision : info.serverRevision === release.revision)
			&& info.schemaVersion === release.schemaVersion) return { revision: Number(info.serverRevision), schemaVersion: release.schemaVersion };
		// Report only bounded deployment identity, never response bodies or credentials.
		const revision = Number.isSafeInteger(info?.serverRevision) ? String(info?.serverRevision) : 'missing';
		const schema = Number.isSafeInteger(info?.schemaVersion) ? String(info?.schemaVersion) : 'missing';
		const liveFingerprint = typeof info?.deploymentFingerprint === 'string' && /^[a-f0-9]{64}$/.test(info.deploymentFingerprint)
			? info.deploymentFingerprint : 'missing or invalid';
		observed = `HTTP ${response.status}; Crate identity ${info?.service === CRATE_SERVICE_ID ? 'matched' : 'missing or different'}; revision ${revision}; schema ${schema}; fingerprint ${liveFingerprint}`;
		if (attempt < 7) await new Promise(resolve => window.setTimeout(resolve, 2000));
	}
	throw new Error(`The updated server did not pass its live check after 8 attempts. Expected revision ${published ? 'at most ' : ''}${release.revision}, schema ${release.schemaVersion}, fingerprint ${fingerprint}. Observed ${observed}. Check and recover the update.`);
}
