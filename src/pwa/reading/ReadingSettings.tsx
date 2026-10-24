import { ChevronRight } from '@/ui/shared/icons/TablerIcon';
import { Button } from '@/ui/shared/Button';
import { SettingsRow } from '../settings/SettingsRow';

export function ReadingSettings({ ready, connected, unavailable, onShortcut }: {
	ready: boolean;
	connected: boolean;
	unavailable?: string;
	onShortcut: () => void;
}) {
	return <>
		<Button size="touch" className="settings-navigation-row" onClick={onShortcut} disabled={!ready || !connected} aria-label="Set up iPhone shortcut">
			<span>Save from iPhone</span><ChevronRight size={16} aria-hidden="true" />
		</Button>
		{(!ready || !connected || unavailable) && <SettingsRow description={unavailable ?? (!ready ? 'Loading Reading settings…' : 'Choose a Reading folder in Obsidian’s Crate settings to connect your library.')} />}
	</>;
}
