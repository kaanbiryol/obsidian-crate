import { SHARED_CHECKPOINT_CAPABILITY } from '../../protocol/history-checkpoints';
import { PWA_ASSET_VERSION } from './pwa-version';
import release from '../server-release.json';
import type { Env } from './types';
import { BATCH_ASSET_UPLOAD_CAPABILITY, BULK_NEW_UPLOAD_CAPABILITY } from '../../protocol/sync-limits';
import {
	CRATE_PLUGIN_PROTOCOL,
	CRATE_SERVICE_ID,
	type CrateServerInfo,
} from '../../protocol';
import { corsResponse } from './cors';
import { INITIAL_IMPORT_CAPABILITY } from '@/protocol/initial-import';

declare const __CRATE_SERVER_VERSION__: string | undefined;

const CRATE_SERVER_VERSION =
	typeof __CRATE_SERVER_VERSION__ === 'string' && __CRATE_SERVER_VERSION__.length > 0
		? __CRATE_SERVER_VERSION__
		: 'dev';

export const CRATE_SERVER_INFO: CrateServerInfo = Object.freeze({
	service: CRATE_SERVICE_ID,
	serverVersion: CRATE_SERVER_VERSION,
	pwaAssetVersion: PWA_ASSET_VERSION,
	protocol: CRATE_PLUGIN_PROTOCOL,
	capabilities: Object.freeze([
        SHARED_CHECKPOINT_CAPABILITY,
    INITIAL_IMPORT_CAPABILITY,
		BATCH_ASSET_UPLOAD_CAPABILITY,
		BULK_NEW_UPLOAD_CAPABILITY,
		'sync-v3',
		'file-revision-deletes',
		'upload-operation-receipts',
		'restore-operation-receipts',
		'reminder-operation-receipts',
		'conditional-file-mutations',
		'settings-v1',
		'devices-v1',
		'reminders-v1',
		'notifications-v1',
	]),
});

export function handleServerInfo(env: Env): Response {
	return corsResponse({ ...CRATE_SERVER_INFO, serverRevision: release.revision, schemaVersion: release.schemaVersion, deploymentFingerprint: env.CRATE_DEPLOYMENT_FINGERPRINT, reminderOperationDay: Math.floor(Date.now() / 86_400_000) }, 200, { 'Cache-Control': 'no-store' });
}
