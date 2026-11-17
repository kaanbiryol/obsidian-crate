import type CratePlugin from './CratePlugin';
import { refreshSharedFeatures } from './feature-settings';
import { ensureReminderNotificationPolicy } from '../reminders/notification-policy-sync';
import { checkReadingSetup } from '../reading/runtime';
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

/** The steps that failed in the last check of the connected server. */
export function serverSetupIssues(plugin: CratePlugin): readonly ServerSetupIssue[] {
	const result = results.get(plugin);
	return result && result.workerUrl === plugin.settings.workerUrl ? result.issues : [];
}

/** Finishes the server side of setup: after connecting, after the first sync of each start,
 * and from Complete server setup. Only failures the server answered with are reported; a step
 * that could not reach the server keeps its earlier result. */
export async function ensureServerSetup(plugin: CratePlugin): Promise<{ issues: readonly ServerSetupIssue[]; unreachable: boolean }> {
	const workerUrl = plugin.settings.workerUrl;
	if (!workerUrl || !plugin.syncRuntime.isConfigured()) return { issues: [], unreachable: false };
	const previous = serverSetupIssues(plugin);
	const issues: ServerSetupIssue[] = [];
	let unreachable = false;
	for (const { step, run } of STEPS) {
		try { await run(plugin); }
		catch (error) {
			if (!isUnreachableServer(error)) issues.push({ step, message: error instanceof Error ? error.message : 'Unknown error' });
			else {
				unreachable = true;
				issues.push(...previous.filter(issue => issue.step === step));
			}
		}
	}
	// A result for a server this device has since left is dropped.
	if (plugin.settings.workerUrl !== workerUrl) return { issues: [], unreachable };
	const changed = JSON.stringify(previous) !== JSON.stringify(issues);
	results.set(plugin, { workerUrl, issues });
	if (changed) plugin.refreshSettingsTab();
	return { issues, unreachable };
}
