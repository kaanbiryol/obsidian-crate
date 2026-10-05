import { describe, expect, it } from 'vitest';
import { buildWorkerMultipartBody, buildResetWorkerMultipartBody, buildServerDeletionWorkerMultipartBody } from './worker-upload-payload';

const artifacts = {
	version: '0.1.0',
	fingerprint: 'f'.repeat(64),
	workerBundle: 'export class ReminderAlarm {}',
	workerBundleSha256: 'worker-hash',
	d1Schema: 'CREATE TABLE IF NOT EXISTS example (id TEXT);',
	d1SchemaSha256: 'schema-hash',
};

describe('Worker upload payloads', () => {
	it('preserves the experimental safety namespace without binding it to active requests', () => {
		const body = new TextDecoder().decode(buildWorkerMultipartBody({ publicOrigin: 'https://crate.workers.dev', artifacts,
			d1DatabaseId: 'database', r2BucketName: 'crate-0123456789abcdef' }).body);
		expect(body).toContain('"CloudSafety":{"type":"durable-object","storage":"sqlite","state":"created"}');
		expect(body).not.toContain('"class_name":"CloudSafety"');
		expect(body).not.toContain('"state":"deleted"');
	});

	it('retires only ReminderAlarm and installs the authenticated cleanup Worker', () => {
		const body = new TextDecoder().decode(buildResetWorkerMultipartBody('reset-id', 'database', 'crate-bucket').body);
		expect(body).toContain('"ReminderAlarm":{"type":"durable-object","state":"deleted"}');
		expect(body).toContain('export class CloudSafety');
		expect(body).not.toContain('export class ReminderAlarm');
		expect(body).toContain('"CloudSafety":{"type":"durable-object","storage":"sqlite","state":"created"}');
		expect(body).not.toContain('"force":true');
		expect(body).toContain('status: 503');
		expect(body).toContain('Crate reset reset-id');
		expect(body).toContain('"name":"CRATE_RESET_ID","text":"reset-id"');
		expect(body).toContain('record.cleanupTokenHash');
		expect(new TextDecoder().decode(buildResetWorkerMultipartBody('reset-id', 'database', 'crate-bucket', true).body)).not.toContain('"state":"deleted"');
	});

	it('builds a module upload with D1, R2, and declarative Durable Object bindings', () => {
		const multipart = buildWorkerMultipartBody({
			publicOrigin: 'https://worker.test',
			vaultName: 'Notes',
			uploadTag: 'crate-12345678-1234-1234-1234-123456789012',
			artifacts,
			d1DatabaseId: '01234567-89ab-cdef-0123-456789abcdef',
			r2BucketName: 'crate-0123456789abcdef',
		});
		const body = new TextDecoder().decode(multipart.body);

		expect(multipart.contentType).toMatch(/^multipart\/form-data; boundary=crate-/);
		expect(body).toContain('"type":"d1","name":"DB"');
		expect(body).toContain('"name":"CRATE_PUBLIC_ORIGIN","text":"https://worker.test"');
		expect(body).toContain('"name":"CRATE_VAULT_NAME","text":"Notes"');
		expect(body).toContain('"type":"r2_bucket","name":"BUCKET"');
		expect(body).toContain('"name":"REMINDER_ALARMS","class_name":"ReminderAlarm"');
		expect(body).not.toContain('"name":"SETUP"');
		expect(body).not.toContain('SetupCoordinator');
		expect(body).toContain('"storage":"sqlite","state":"created"');
		expect(body).toContain('"workers/tag":"crate-12345678-1234-1234-1234-123456789012"');
		expect(body).toContain(`"workers/message":"Crate 0.1.0 ${'f'.repeat(64)}"`);
		expect(body).toContain(artifacts.workerBundle);
	});

	it('limits the terminal cleanup helper to the selected bucket and hashed capability', () => {
		const id = 'a'.repeat(32), hash = 'b'.repeat(64), tag = `crate-${crypto.randomUUID()}`;
		const body = new TextDecoder().decode(buildServerDeletionWorkerMultipartBody(id, 'crate-0123456789abcdef', hash, tag).body);
		const metadata = JSON.parse(body.split('\r\n\r\n')[1]!.split('\r\n--')[0]!) as { bindings: unknown[]; annotations: Record<string, string> };
		expect(metadata.bindings).toEqual([{ type: 'r2_bucket', name: 'BUCKET', bucket_name: 'crate-0123456789abcdef' },
			{ type: 'plain_text', name: 'CRATE_RESET_ID', text: id }, { type: 'plain_text', name: 'CRATE_DELETE_TOKEN_HASH', text: hash },
			{ type: 'plain_text', name: 'CRATE_DELETE_UPLOAD_TAG', text: tag }]);
		expect(metadata.annotations).toEqual({ 'workers/message': `Crate deletion ${id}`, 'workers/tag': tag });
		expect(body).not.toContain('sqlite_master');
	});
});
