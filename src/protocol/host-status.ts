import { isRecord } from '../platform/validation';

/** The `maintenance_state` key a self-hosted server's host process writes its status to. */
export const HOST_STATUS_KEY = 'crate_host_status';
export const HOST_STATUS_PATH = '/server/host-status';

export type HostInstall = 'docker' | 'source' | 'npx' | 'npm';
const INSTALLS: readonly HostInstall[] = ['docker', 'source', 'npx', 'npm'];

/** What the computer running a self-hosted server reports about itself. Paths and error
 * text stay on that computer; times are ISO strings. */
export interface HostStatus {
	install: HostInstall;
	startedAt: string;
	lastBackupAt: string | null;
	autoBackup: { on: boolean; lastFailureAt: string | null };
	/** Whether the public address reaches this server; null for a local-only server. */
	publicAccess: 'ready' | 'waiting' | null;
	diskFreeBytes: number | null;
}

const isTime = (value: unknown): value is string => typeof value === 'string' && value.length <= 40 && !Number.isNaN(Date.parse(value));
const isOptionalTime = (value: unknown): value is string | null => value === null || isTime(value);

/** Reads a stored or served status, dropping unknown fields; null when malformed. */
export function parseHostStatus(value: unknown): HostStatus | null {
	if (!isRecord(value) || !INSTALLS.includes(value.install as HostInstall) || !isTime(value.startedAt)
		|| !isOptionalTime(value.lastBackupAt) || !isRecord(value.autoBackup) || typeof value.autoBackup.on !== 'boolean'
		|| !isOptionalTime(value.autoBackup.lastFailureAt)
		|| !(value.publicAccess === null || value.publicAccess === 'ready' || value.publicAccess === 'waiting')
		|| !(value.diskFreeBytes === null || Number.isSafeInteger(value.diskFreeBytes) && (value.diskFreeBytes as number) >= 0)) return null;
	return {
		install: value.install as HostInstall,
		startedAt: value.startedAt,
		lastBackupAt: value.lastBackupAt,
		autoBackup: { on: value.autoBackup.on, lastFailureAt: value.autoBackup.lastFailureAt },
		publicAccess: value.publicAccess,
		diskFreeBytes: value.diskFreeBytes as number | null,
	};
}

/** The route's body: a Cloudflare deployment has no host process and answers null. */
export function parseHostStatusResponse(value: unknown): HostStatus | null {
	return isRecord(value) ? parseHostStatus(value.host) : null;
}
