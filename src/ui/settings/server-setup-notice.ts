import { Notice, Setting } from 'obsidian';
import { ensureServerSetup, serverSetupIssues, type ServerSetupStep } from '../../plugin/server-setup';
import { readingSetupError } from '../../reading/runtime';
import type { SettingsSectionContext } from './section-helpers';

const STEP_NAMES: Record<ServerSetupStep, string> = { features: 'Shared features', reminders: 'Reminders', reading: 'Reading' };

/** Shown at the top of settings while the server answered that part of its setup failed. */
export function renderServerSetupNotice({ containerEl, plugin, rerender }: SettingsSectionContext): void {
	if (!plugin.syncRuntime.isConfigured()) return;
	// Reading also checks when its notes change, so its line shows the latest answer.
	const lines = serverSetupIssues(plugin).filter(issue => issue.step !== 'reading').map(issue => `${STEP_NAMES[issue.step]}: ${issue.message}`);
	const reading = readingSetupError(plugin);
	if (reading) lines.push(`${STEP_NAMES.reading}: ${reading}`);
	if (!lines.length) return;
	new Setting(containerEl)
		.setName('Server setup isn’t complete')
		.setDesc(`Crate couldn’t finish setting up your server, so these features may not work on other devices or the web app. ${lines.join(' · ')}`)
		.addButton(button => button.setButtonText('Complete server setup').setCta().onClick(async () => {
			button.setDisabled(true);
			try {
				const { issues, unreachable } = await ensureServerSetup(plugin);
				if (unreachable) new Notice('Could not reach your Crate server. Check your connection and try again.');
				else if (!issues.length && !readingSetupError(plugin)) new Notice('Server setup is complete.');
			} finally { rerender(); }
		}));
}
