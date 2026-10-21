import { Check } from 'lucide-react';
import { PwaButton as Button } from '../components/PwaButton';
import { SettingsRow } from '../settings/SettingsRow';
import { SettingsSection } from '../settings/SettingsSection';
import type { RemindersSettings } from '../settings/settings-store';
import type { HomeScreenPlatform } from '../hooks/useHomeScreenInstall';

export function ReminderSettings({ model, homeScreenPlatform }: {
	model: RemindersSettings | null;
	homeScreenPlatform: HomeScreenPlatform | null;
}) {
	const push = model?.push;
	const available = model?.ready && model.connected;
	return <SettingsSection title="Notifications">
		{!available ? <SettingsRow title="Push notifications" description={!model?.ready ? 'Loading reminder settings…' : 'Open a fresh web app link from Obsidian to connect Reminders.'} /> : <>
			<SettingsRow title="Push notifications" description={push && ['blocked', 'error', 'install', 'paused'].includes(push.phase) ? <span aria-live="polite">{push.status}</span>
				: push?.phase === 'enabled' && model.config.allDayNotificationTime ? `All-day reminders alert at ${model.config.allDayNotificationTime}.` : undefined}>
				{push?.phase === 'enabled' ? <span className="settings-status is-success"><Check size={12} /> On</span>
					: push?.phase === 'paused' ? <span className="settings-status">Off for vault</span>
					: push?.phase === 'checking' ? <span className="settings-status" role="status">Checking…</span>
					: push?.phase === 'blocked' ? <span className="settings-status">Blocked</span>
					: homeScreenPlatform === 'ios' || push?.phase === 'install' ? <span className="settings-status">Install first</span>
					: push?.phase === 'off' || push?.phase === 'error' ? <Button size="touch" variant="ghost" className="settings-inline-action" data-action="enable-push" onClick={model.onEnablePush}>{push.phase === 'error' ? 'Retry' : 'Enable'}</Button>
					: <span className="settings-status">Not supported</span>}
			</SettingsRow>
		</>}
	</SettingsSection>;
}
