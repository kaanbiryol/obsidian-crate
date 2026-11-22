/// <reference types="@cloudflare/vitest-plugin/types" />
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import { applySchema } from '../test-support/schema-test-harness';
import worker from '../index';
import { writeCommittedMarkdownFile } from '../sync/markdown-files';
import { sha256Hex } from '@/platform/sha256';
import { CRATE_PLUGIN_PROTOCOL, CRATE_PROTOCOL_HEADER } from '@/protocol/server-info';
import { meterD1Usage } from '../d1/d1-usage';
import { installStorageCostMeter } from '../test-support/storage-cost-test-harness';
import { SUBREQUESTS_PER_INVOCATION } from '../d1/platform-limits';
import { DISPATCH_BATCH_SIZE, deliverDueReminders } from './dispatcher';
import { sendPushNotificationWithoutContact } from './web-push';

// Each send is one fetch to the device's push service.
vi.mock('./web-push', async importOriginal => ({ ...await importOriginal<typeof import('./web-push')>(), sendPushNotificationWithoutContact: vi.fn() }));

// Each push is a fetch, and the Free plan counts fetches and D1 queries against one
// subrequest limit per invocation, so a pass sends fewer reminders to more devices.

const PATH = 'Reminders/Many.md';
const COUNT = DISPATCH_BATCH_SIZE;
const DEVICES = 3;

beforeEach(async () => {
	await applySchema(env.DB);
	await env.DB.prepare("INSERT INTO auth_tokens(id, token_hash, scope, folder_path, last_seen_at) VALUES ('web', ?, 'reminders', 'Reminders', datetime('now'))")
		.bind(await sha256Hex('web-session')).run();
	await env.DB.prepare("INSERT INTO notification_policy(id, folder_path, timezone, revision) VALUES (1, 'Reminders', 'UTC', 'policy')").run();
	await writeCommittedMarkdownFile(env.BUCKET, env.DB, PATH, `# Tasks\n\n${Array.from({ length: COUNT }, (_, index) =>
		`- [ ] Task ${index} 2099-01-01T09:00:00.000Z <!-- crate-id:${crypto.randomUUID()} -->`).join('\n')}\n`, null);
	const list = () => worker.fetch(new Request('https://crate.test/reminders/list?folderPath=Reminders', {
		headers: { Authorization: 'Bearer web-session', [CRATE_PROTOCOL_HEADER]: String(CRATE_PLUGIN_PROTOCOL.current) } }), env);
	// Projection runs in the coordinator's alarms; the meter drains them.
	const meter = await installStorageCostMeter();
	for (let attempt = 0; attempt < 20 && (await list()).status === 202; attempt++);
	await meter.settle();
	await meter.restore();
	for (let device = 0; device < DEVICES; device++) {
		await env.DB.prepare(`INSERT INTO push_subscriptions (id, endpoint, p256dh, auth, owner_token_id, folder_path) VALUES (?, ?, 'key', 'auth', 'web', 'Reminders')`)
			.bind(`device-${device}`, `https://push.example.com/${device}`).run();
	}
	await env.DB.prepare('UPDATE reminder_projections SET due_at = ? WHERE due_at IS NOT NULL').bind(Date.now()).run();
});
afterEach(async () => { vi.clearAllMocks(); await reset(); });

it(`delivers ${COUNT} due reminders to ${DEVICES} devices within the subrequest limit of each pass`, async () => {
	let pushes = 0;
	vi.mocked(sendPushNotificationWithoutContact).mockImplementation(async () => { pushes++; return new Response(null, { status: 201 }); });
	const delivered = async () => (await env.DB.prepare('SELECT COUNT(*) AS n FROM reminder_projections WHERE delivered_due IS NOT NULL').first<{ n: number }>())!.n;
	let passes = 0;
	while (await delivered() < COUNT && passes < COUNT) {
		pushes = 0;
		const meter = meterD1Usage(env.DB);
		await deliverDueReminders({ ...env, DB: meter.db });
		expect(pushes + meter.usage.queries).toBeLessThanOrEqual(SUBREQUESTS_PER_INVOCATION);
		passes++;
	}
	expect(await delivered()).toBe(COUNT);
});
