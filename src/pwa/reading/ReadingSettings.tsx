import { ChevronRight } from 'lucide-react';
import { Button } from '@/ui/shared/Button';
import { SettingsRow } from '../settings/SettingsRow';

export function ReadingSettings({ ready, connected, encrypted, unavailable, onShortcut }: {
	ready: boolean;
	connected: boolean;
	/** Save to Crate cannot encrypt or hash search terms, so encrypted vaults do not offer it. */
	encrypted: boolean;
	unavailable?: string;
	onShortcut: () => void;
}) {
	return <>
		<Button size="touch" className="settings-navigation-row" onClick={onShortcut} disabled={!ready || !connected || encrypted} aria-label="Set up iPhone shortcut">
			<span>Save from iPhone</span><ChevronRight size={16} aria-hidden="true" />
		</Button>
		{(!ready || !connected || unavailable || encrypted) && <SettingsRow description={unavailable ?? (!ready ? 'Loading Reading settings…' : !connected ? 'Choose a Reading folder in Obsidian’s Crate settings to connect your library.' : 'Not available in encrypted vaults. Save links here or in Obsidian.')} />}
	</>;
}
