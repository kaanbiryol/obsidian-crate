import { featureEnabled } from '../server/feature-policy';
import { sendToAllSubscriptions } from './push';
import type { Env } from '../types';

/** What a self-hosted server's host process can warn enrolled devices about. The text names
 * no paths or vault data: alerts are not end-to-end encrypted. */
export const HOST_ALERTS = {
	'backup-failed': 'The automatic backup on your Crate server failed. Run crate-server doctor on that computer.',
	'public-access-lost': 'Your Crate server cannot be reached from the internet. Devices sync again once it is back.',
	'low-disk': 'Your Crate server computer is almost out of disk space. Free some space so sync and backups keep working.',
} as const;
export type HostAlertKind = keyof typeof HOST_ALERTS;

export const isHostAlertKind = (value: unknown): value is HostAlertKind => typeof value === 'string' && Object.hasOwn(HOST_ALERTS, value);

/** Sends a host alert to the devices that receive reminders. Paused reminders send nothing. */
export async function deliverHostAlert(env: Pick<Env, 'DB' | 'CRATE_PUBLIC_ORIGIN'>, kind: HostAlertKind): Promise<{ sent: number }> {
	if (!await featureEnabled(env.DB, 'reminders')) return { sent: 0 };
	const delivery = await sendToAllSubscriptions(env.DB, {
		title: 'Crate server needs attention', body: HOST_ALERTS[kind], tag: `crate-server-${kind}`,
	}, { origin: env.CRATE_PUBLIC_ORIGIN ?? '' });
	return { sent: delivery.sent };
}
