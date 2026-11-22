import { DEVELOPMENT_BUILD } from '../../../protocol/server-build';
import { DEVICE_PAIRING_CAPABILITY } from '../../../protocol/device-pairing';
import { SHARED_CHECKPOINT_CAPABILITY } from '../../../protocol/history-checkpoints';
import { PWA_ASSET_VERSION } from '../../../pwa/shell/version';
import release from '../../server-release.json';
import type { Env } from '../types';
import { maxFileBytes } from './file-limit';
import { BATCH_LIMITS } from '../sync/storage';
import { BULK_NEW_UPLOAD_CAPABILITY, CHUNKED_UPLOAD_CAPABILITY, MAX_FILE_SIZE_BYTES } from '../../../protocol/sync-limits';
import {
	CRATE_PLUGIN_PROTOCOL,
	CRATE_SERVICE_ID,
	type CrateServerInfo,
} from '../../../protocol/server-info';
import { corsResponse } from '../http/cors';
import { INITIAL_IMPORT_CAPABILITY } from '@/protocol/initial-import';
import { READING_SHORTCUT_CONTRACT } from '@/reading/shortcut';
import { ENCRYPTION_CAPABILITY } from '../../../encryption/server-state';

declare const __CRATE_SERVER_VERSION__: string | undefined;

const CRATE_SERVER_VERSION =
	typeof __CRATE_SERVER_VERSION__ === 'string' && __CRATE_SERVER_VERSION__.length > 0
		? __CRATE_SERVER_VERSION__
		: 'dev';

/** The fixed part of the metadata; each response adds the revision and the current operation day. */
export const CRATE_SERVER_INFO: Omit<CrateServerInfo, 'serverRevision' | 'reminderOperationDay'> = Object.freeze({
	service: CRATE_SERVICE_ID,
	serverVersion: CRATE_SERVER_VERSION,
	pwaAssetVersion: PWA_ASSET_VERSION,
	protocol: CRATE_PLUGIN_PROTOCOL,
	capabilities: Object.freeze([
		'web-pairing-v1',
		DEVICE_PAIRING_CAPABILITY,
		ENCRYPTION_CAPABILITY,
		'e2ee-reset-v1',
				SHARED_CHECKPOINT_CAPABILITY,
		INITIAL_IMPORT_CAPABILITY,
		BULK_NEW_UPLOAD_CAPABILITY,
		'sync-v1',
		'file-revision-deletes',
		'upload-operation-receipts',
		'restore-operation-receipts',
		'reminder-operation-receipts',
		'conditional-file-mutations',
		'settings-v1',
		'devices-v1',
		'reminders-v1',
 'reading-v1', 'reading-fetching-consent-v1', 'shared-features-v1',
 'reading-shortcut-pairing-v1',
 'reading-shortcut-transport-v1',
		'notifications-v1',
	]),
});

/** Reads no database, so installation can probe the build before creating its schema. */
export async function handleServerInfo(env: Env): Promise<Response> {
	const limit = maxFileBytes(env);
	// A Cloudflare server never raises its limit, so it advertises no limits. Only a raised
	// limit allows files that travel in parts.
	const selfHosted = __CRATE_SELF_HOSTED__ ? {
		limits: { maxFileBytes: limit, batch: BATCH_LIMITS },
		capabilities: limit > MAX_FILE_SIZE_BYTES ? [...CRATE_SERVER_INFO.capabilities, CHUNKED_UPLOAD_CAPABILITY] : CRATE_SERVER_INFO.capabilities,
	} : {};
	return corsResponse({ ...CRATE_SERVER_INFO, ...selfHosted,
		shortcut: { version: READING_SHORTCUT_CONTRACT.version, revision: READING_SHORTCUT_CONTRACT.revision, minimumRevision: READING_SHORTCUT_CONTRACT.minimumRevision }, serverRevision: release.revision, ...(DEVELOPMENT_BUILD ? { developmentBuild: DEVELOPMENT_BUILD } : {}), schemaVersion: release.schemaVersion, deploymentFingerprint: env.CRATE_DEPLOYMENT_FINGERPRINT,
		reminderOperationDay: Math.floor(Date.now() / 86_400_000) }, 200, { 'Cache-Control': 'no-store' });
}

export async function handleHealth(): Promise<Response> {
	return corsResponse({ status: 'ok', timestamp: new Date().toISOString() });
}
