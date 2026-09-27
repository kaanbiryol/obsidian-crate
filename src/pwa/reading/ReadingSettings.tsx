import { ChevronRight } from 'lucide-react';
import { Button } from '@/ui/shared/Button';
import { SettingsSection } from '../components/SettingsSection';
import { SettingsRow } from '../components/SettingsRow';

export function ReadingSettings({ ready, connected, unavailable, onShortcut }: {
	ready: boolean;
	connected: boolean;
	unavailable?: string;
	onShortcut: () => void;
}) {
	return <SettingsSection title="Reading">
		<Button size="touch" className="settings-navigation-row" onClick={onShortcut} disabled={!ready || !connected} aria-label="Set up iPhone shortcut">
			<span>Save from iPhone</span><ChevronRight size={16} aria-hidden="true" />
		</Button>
		{(!ready || !connected || unavailable) && <SettingsRow description={unavailable ?? (!ready ? 'Loading Reading settings…' : 'Enable server reading in Obsidian to connect your library.')} />}
		<p className="settings-help">Opened articles are available offline.</p>
	</SettingsSection>;
}
