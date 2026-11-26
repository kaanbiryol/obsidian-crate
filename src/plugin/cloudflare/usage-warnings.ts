import type CratePlugin from '../CratePlugin';
import { currentUsageWarningState, newUsageWarnings, type UsageWarning } from '../../cloudflare/usage/usage-warnings';
import { createLogger } from '../../sync/logger';
import { errorMessage } from '../../platform/logger';

const logger = createLogger('Usage warnings');
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
/** Cloudflare is asked at most this often; the timer itself only compares timestamps. */
const CHECK_EVERY_MS = DAY_MS;
const TICK_MS = HOUR_MS;
// After startup settles, so the check never slows Obsidian's launch.
const STARTUP_DELAY_MS = 60_000;
// A failed check retries later instead of on every tick.
const RETRY_AFTER_MS = 6 * HOUR_MS;
// A sign-in that could not renew for this long means warnings have stopped.
const PAUSED_AFTER_MS = 3 * DAY_MS;

export interface UsageWarningNotices { warn(warnings: UsageWarning[]): void; paused(): void }
type Host = Pick<CratePlugin, 'settings' | 'cloudflareSavedLogin' | 'writeSettings'>;

/** Checks account usage when the last check is a day old. Resolves whether it asked Cloudflare. */
export async function checkUsageWarnings(host: Host, notices: UsageWarningNotices, signal: AbortSignal, now = Date.now()): Promise<boolean> {
	const { settings, cloudflareSavedLogin: login } = host;
	// A device without a saved sign-in, such as a paired one, leaves this to a device that has one.
	if (!settings.usageWarnings || !settings.cloudflareDeployment?.accountId || !login.connected) return false;
	const checkedAt = login.snapshot?.updatedAt ?? 0;
	if (now - checkedAt < CHECK_EVERY_MS) return false;
	const { pausedShown, ...state } = currentUsageWarningState(settings.usageWarningState, new Date(now));
	try {
		const groups = await login.fetchUsage();
		if (signal.aborted) return true;
		const result = newUsageWarnings(groups, state);
		if (result.warnings.length) notices.warn(result.warnings);
		if (result.warnings.length || pausedShown) await host.writeSettings({ usageWarningState: result.state });
	} catch (error) {
		if (signal.aborted) return true;
		logger.debug('Usage check failed:', errorMessage(error));
		if (login.needsAuthorization && !pausedShown && now - checkedAt >= PAUSED_AFTER_MS) {
			notices.paused();
			await host.writeSettings({ usageWarningState: { ...state, pausedShown: true } });
		}
	}
	return true;
}

/** Checks shortly after startup and then hourly, so a device left open still checks daily. */
export function registerUsageWarnings(plugin: Host & Pick<CratePlugin, 'registerInterval'>, notices: UsageWarningNotices, signal: AbortSignal): void {
	let running = false;
	let retryAt = 0;
	const tick = () => {
		if (running || signal.aborted || Date.now() < retryAt) return;
		running = true;
		void checkUsageWarnings(plugin, notices, signal)
			.then(asked => { if (asked) retryAt = Date.now() + RETRY_AFTER_MS; })
			.catch((error: unknown) => { logger.debug('Usage check failed:', errorMessage(error)); })
			.finally(() => { running = false; });
	};
	const startup = window.setTimeout(tick, STARTUP_DELAY_MS);
	signal.addEventListener('abort', () => window.clearTimeout(startup), { once: true });
	plugin.registerInterval(window.setInterval(tick, TICK_MS));
}
