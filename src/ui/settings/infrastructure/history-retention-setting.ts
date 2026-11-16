import { Notice, type Setting } from 'obsidian';
import type CratePlugin from '../../../plugin/CratePlugin';
import { serverRequest } from '../../../plugin/server-request';
import { HISTORY_RETENTION_DAYS, parseHistoryRetention, type HistoryRetentionDays } from '../../../protocol/history-retention';
import { openConfirmationModal } from '../../plugin/confirmation-modal';
import { errorMessage } from '../../../platform/logger';

type RetentionHost = Pick<CratePlugin, 'app' | 'settings' | 'secretStorage'>;

const label = (days: number) => days === 365 ? '1 year' : `${days} days`;

async function requestRetention(plugin: RetentionHost, body?: { days: HistoryRetentionDays }): Promise<HistoryRetentionDays> {
	const retention = parseHistoryRetention(await serverRequest<unknown>(plugin, '/history-retention', body, { timeout: 10_000 }));
	if (!retention) throw new Error('Could not read the history period.');
	return retention.days;
}

/** Adds the server's history period to `setting`. Every device shares it. */
export function addHistoryRetentionDropdown(setting: Setting, plugin: RetentionHost): void {
	setting.addDropdown(dropdown => {
		for (const days of HISTORY_RETENTION_DAYS) dropdown.addOption(String(days), label(days));
		dropdown.setDisabled(true);
		let current: HistoryRetentionDays | null = null;
		void requestRetention(plugin).then(days => {
			current = days;
			dropdown.setValue(String(days)).setDisabled(false);
		}).catch(() => { dropdown.selectEl.title = 'Could not load the history period from your server.'; });
		dropdown.onChange(async value => {
			const days = Number(value) as HistoryRetentionDays;
			if (current === null || days === current) return;
			const previous = current;
			if (days < previous && !await openConfirmationModal(plugin.app, {
				title: 'Keep less history',
				message: `File versions and saved vault states older than ${label(days)} will be removed from your server. This can't be undone.`,
				confirmText: 'Keep less history',
				warning: true,
			})) {
				dropdown.setValue(String(previous));
				return;
			}
			dropdown.setDisabled(true);
			try { current = await requestRetention(plugin, { days }); }
			catch (error) { new Notice(`Could not change the history period: ${errorMessage(error)}`); }
			finally { dropdown.setValue(String(current)).setDisabled(false); }
		});
	});
}
