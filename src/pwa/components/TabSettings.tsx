import { ArrowDown, ArrowUp } from 'lucide-react';
import { DEFAULT_DOCK_TABS, type DockTab } from '../dock-preferences';
import type { PwaPreferences } from '../preferences';
import { PwaButton as Button } from './PwaButton';
import { SettingsRow } from './SettingsRow';
import { SettingsSection } from './SettingsSection';

const labels: Record<DockTab, string> = { inbox: 'Inbox', today: 'Schedule', browse: 'Projects', reading: 'Reading' };

export function TabSettings({ preferences, onChange }: {
	preferences: PwaPreferences;
	onChange: (patch: Partial<PwaPreferences>) => void;
}) {
	const tabs = preferences.dockTabs;
	const rows = [...tabs, ...DEFAULT_DOCK_TABS.filter(tab => !tabs.includes(tab))];
	const move = (index: number, offset: number) => {
		const next = [...tabs];
		[next[index], next[index + offset]] = [next[index + offset]!, next[index]!];
		onChange({ dockTabs: next });
	};
	return <SettingsSection title="Tabs">
		<p className="settings-tabs-description">Choose the bottom tabs and their order on this device. Keep at least one visible.</p>
		{rows.map(tab => {
			const index = tabs.indexOf(tab);
			const visible = index >= 0;
			return <SettingsRow key={tab} title={labels[tab]}>
				<div className="settings-tab-controls">
					<Button variant="ghost" aria-label={`Move ${labels[tab]} up`} disabled={!visible || index === 0} onClick={() => move(index, -1)}><ArrowUp size={18} aria-hidden="true" /></Button>
					<Button variant="ghost" aria-label={`Move ${labels[tab]} down`} disabled={!visible || index === tabs.length - 1} onClick={() => move(index, 1)}><ArrowDown size={18} aria-hidden="true" /></Button>
					<input type="checkbox" aria-label={`Show ${labels[tab]} tab`} checked={visible} disabled={visible && tabs.length === 1}
						onChange={() => onChange({ dockTabs: visible ? tabs.filter(value => value !== tab) : [...tabs, tab] })} />
				</div>
			</SettingsRow>;
		})}
		<Button variant="ghost" size="touch" onClick={() => onChange({ dockTabs: [...DEFAULT_DOCK_TABS] })}>Reset tabs</Button>
	</SettingsSection>;
}
