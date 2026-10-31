/**
 * Frozen wire formats shared by the plugin, PWA and Worker. Released clients and
 * stored R2 objects depend on these exact shapes.
 *
 * Fixtures in `__fixtures__/` are append-only. To freeze a new version, append an
 * entry below with a new file name (for example `server-info.v2.json`), then run
 * `CRATE_WRITE_FIXTURES=server-info.v2.json npx vitest run src/protocol/protocol.fixtures.test.ts`.
 * Only the missing file is written; review and commit it. Never edit or
 * regenerate an existing fixture. See `src/test/frozen-fixtures.ts`.
 */
import { describe } from 'vitest';
import { testFrozenFixtures } from '@/test/frozen-fixtures';
import { isCompatibleCrateServer, parseCrateServerInfo } from './server-info';
import { parseSharedCheckpointDocument, parseSharedCheckpointList } from './history-checkpoints';
import { normalizeSharedSettingsValue } from './shared-settings';
import { isReminderOperationId, reminderOperationDay } from './reminder-operation';

const hash = (digit: string) => digit.repeat(64);
const checkpoint = { id: '0f0f0f0f-1111-4222-8333-444444444444', sequence: 12, timestamp: '2026-09-20T10:00:00.000Z', expiresAt: Date.parse('2026-10-20T10:00:00.000Z'), fileCount: 3 };

describe('frozen protocol fixtures', () => {
	testFrozenFixtures(new URL('./__fixtures__/', import.meta.url), [
		{
			// The 0.9.0 Worker's public handshake, including fields older parsers ignore.
			file: 'server-info.v1.json',
			stored: () => ({
				service: 'crate', serverVersion: '0.9.0', pwaAssetVersion: 'fixture-pwa-1',
				protocol: { current: 1, oldestCompatible: 1 },
				capabilities: ['web-pairing-v1', 'e2ee-v1', 'e2ee-reset-v1', 'shared-history-checkpoints-v1', 'resumable-initial-import-v1',
					'bulk-new-file-uploads-v1', 'sync-v1', 'file-revision-deletes', 'upload-operation-receipts', 'restore-operation-receipts',
					'reminder-operation-receipts', 'conditional-file-mutations', 'settings-v1', 'devices-v1', 'reminders-v1', 'reading-v1',
					'reading-fetching-consent-v1', 'shared-features-v1', 'reading-shortcut-pairing-v1', 'reading-shortcut-transport-v1', 'notifications-v1'],
				shortcut: { version: 1, revision: 1, minimumRevision: 1 },
				serverRevision: 2, schemaVersion: 1, deploymentFingerprint: hash('d'), reminderOperationDay: 20757,
			}),
			decode: (stored: unknown) => {
				const info = parseCrateServerInfo(stored);
				return { info, compatible: info ? isCompatibleCrateServer(info) : null };
			},
		},
		{
			file: 'shared-checkpoint-list.v1.json',
			stored: () => ({ version: 1, checkpoints: [checkpoint, { ...checkpoint, id: '0f0f0f0f-1111-4222-8333-555555555555', sequence: 9, fileCount: 0 }] }),
			decode: (stored: unknown) => parseSharedCheckpointList(stored),
		},
		{
			// Server-authored R2 inventory, with names that collide with object prototype keys.
			file: 'shared-checkpoint-document.v1.json',
			stored: () => ({ version: 1, checkpoint, files: {
				'Notes/hello.md': { hash: hash('a'), size: 21, modified: '2026-09-20 09:59:00', revision: `__crate__/files/${hash('a')}/fixture-revision-a` },
				['__proto__']: { hash: hash('b'), size: 4, modified: '2026-09-19T08:00:00Z', revision: `__crate__/files/${hash('b')}/fixture-revision-b` },
				'Attachments/Ünïcødé image.png': { hash: hash('c'), size: 2048, modified: '2026-09-18', revision: `__crate__/files/${hash('c')}/fixture-revision-c` },
			} }),
			decode: (stored: unknown) => {
				const document = parseSharedCheckpointDocument(stored);
				return { ...document, paths: Object.keys(document.files) };
			},
		},
		{
			// `/settings` body: duplicates and blanks normalize, longer timers clamp.
			file: 'shared-settings.v1.json',
			stored: () => ({ ignorePatterns: ['.git/', ' .git/ ', '', 'Private/**'], syncInterval: 300, pushEnabled: true }),
			decode: (stored: unknown) => normalizeSharedSettingsValue(stored),
		},
		{
			// Operation IDs saved in upload journals, checkpoints and browser outboxes.
			file: 'operation-ids.v1.json',
			stored: () => ['e1_00020757_0a14f966-767d-4908-8cc9-b1f0f10d1cc2', 'e1_00020000_saved-operation-id-123456', 'operation_123456789'],
			decode: (stored: string[]) => stored.map(id => ({ id, valid: isReminderOperationId(id), day: reminderOperationDay(id) })),
		},
	]);
});
