import type CratePlugin from './CratePlugin';
import { refreshSharedFeatures } from './feature-settings';
import { ensureReminderNotificationPolicy } from '../reminders/notification-policy-sync';
import { checkReadingSetup, ReadingSetupBusyError } from '../reading/runtime';
import { isUnreachableServer } from './server-request';

export type ServerSetupStep = 'features' | 'reminders' | 'reading';
export interface ServerSetupIssue { step: ServerSetupStep; message: string }

/** Each step only saves what this vault already chose, so running it again is safe. */
const STEPS: readonly { step: ServerSetupStep; run: (plugin: CratePlugin) => Promise<void> }[] = [
	{ step: 'features', run: plugin => refreshSharedFeatures(plugin) },
	{ step: 'reminders', run: plugin => ensureReminderNotificationPolicy(plugin, true) },
	{ step: 'reading', run: plugin => checkReadingSetup(plugin) },
];

const results = new WeakMap<CratePlugin, { workerUrl: string; issues: ServerSetupIssue[] }>();
/** The last requested check; each waits for the one before, so none overwrites a newer result. */
const queued = new WeakMap<CratePlugin, Promise<unknown>>();

export interface ServerSetupResult {
	issues: readonly ServerSetupIssue[];
	unreachable: boolean;
	/** Why a step had to wait, such as a running sync; its earlier result stays. */
	deferred?: string;
}

/** The steps that failed in the last check of the connected server. */
export function serverSetupIssues(plugin: CratePlugin): readonly ServerSetupIssue[] {
	const result = results.get(plugin);
	return result && result.workerUrl === plugin.settings.workerUrl ? result.issues : [];
}

/** Finishes the server side of setup: after connecting, after the first sync of each start,
 * and from Complete server setup. Only failures the server answered with are reported; a step
 * that could not reach the server keeps its earlier result. */
export function ensureServerSetup(plugin: CratePlugin): Promise<ServerSetupResult> {
	const run = (queued.get(plugin) ?? Promise.resolve()).catch(() => {}).then(() => checkServerSetup(plugin));
	queued.set(plugin, run);
	return run;
}

async function checkServerSetup(plugin: CratePlugin): Promise<ServerSetupResult> {
	const workerUrl = plugin.settings.workerUrl;
	if (!workerUrl || !plugin.syncRuntime.isConfigured()) return { issues: [], unreachable: false };
	const previous = serverSetupIssues(plugin);
	const issues: ServerSetupIssue[] = [];
	let unreachable = false, deferred: string | undefined;
	for (const { step, run } of STEPS) {
		try { await run(plugin); }
		catch (error) {
			const busy = error instanceof ReadingSetupBusyError;
			if (!busy && !isUnreachableServer(error)) issues.push({ step, message: error instanceof Error ? error.message : 'Unknown error' });
			else {
				if (busy) deferred = error.message;
				else unreachable = true;
				issues.push(...previous.filter(issue => issue.step === step));
			}
		}
	}
	// A result for a server this device has since left is dropped.
	if (plugin.settings.workerUrl !== workerUrl) return { issues: [], unreachable, deferred };
	const changed = JSON.stringify(previous) !== JSON.stringify(issues);
	results.set(plugin, { workerUrl, issues });
	if (changed) plugin.refreshSettingsTab();
	return { issues, unreachable, deferred };
}
