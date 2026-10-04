import { PWA_CONTROL_SPRING } from '../motion';
import { useId } from 'react';
import { ChevronDown, GripVertical } from 'lucide-react';
import { Reorder, useDragControls, useReducedMotion } from 'motion/react';
import { DEFAULT_DOCK_TABS, DOCK_TABS, type DockTab } from '../dock-preferences';
import type { PwaPreferences } from '../preferences';
import { ThemeIcon } from '@/ui/shared/ThemeIcon';
import { PwaButton as Button } from './PwaButton';
import { SettingsSection } from './SettingsSection';
import { SettingsRow } from './SettingsRow';

function TabRow({ tab, tabs, onChange, description }: {
	tab: DockTab; tabs: DockTab[]; onChange: (tabs: DockTab[]) => void; description: string;
}) {
	const controls = useDragControls();
	const reducedMotion = useReducedMotion();
	const item = DOCK_TABS.find(item => item.id === tab)!;
	return <Reorder.Item value={tab} dragListener={false} dragControls={controls} layout="position" transition={reducedMotion ? { duration: 0 } : PWA_CONTROL_SPRING}
		className="settings-tab-row" data-settings-tab={tab}>
		<ThemeIcon id={item.iconName} size="m" aria-hidden="true" />
		<span className="settings-tab-choice">
			<select aria-label={`Tab ${tabs.indexOf(tab) + 1}`} aria-describedby={description} value={tab}
				onChange={event => onChange(tabs.map(value => value === tab ? event.currentTarget.value as DockTab : value))}>
				{DOCK_TABS.filter(item => item.id === tab || !tabs.includes(item.id)).map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
			</select>
			<ChevronDown size={14} aria-hidden="true" />
		</span>
		<Button variant="ghost" className="settings-tab-handle" aria-label={`Reorder ${item.label}`} aria-describedby={description}
			onPointerDown={event => controls.start(event)} onKeyDown={event => {
				if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
				event.preventDefault();
				const index = tabs.indexOf(tab), nextIndex = index + (event.key === 'ArrowUp' ? -1 : 1);
				if (nextIndex < 0 || nextIndex >= tabs.length) return;
				const next = [...tabs];
				next.splice(index, 1); next.splice(nextIndex, 0, tab); onChange(next);
			}}><GripVertical size={18} aria-hidden="true" /></Button>
	</Reorder.Item>;
}

export function TabSettings({ preferences, onChange }: {
	preferences: PwaPreferences;
	onChange: (patch: Partial<PwaPreferences>) => void;
}) {
	const tabs = preferences.dockTabs;
	const description = useId();
	const customized = tabs.some((tab, index) => tab !== DEFAULT_DOCK_TABS[index]);
	const changeTabs = (dockTabs: DockTab[]) => onChange({ dockTabs });
	return <SettingsSection title="Tabs" action={customized && <Button variant="ghost" size="touch" className="settings-tabs-reset" onClick={() => changeTabs([...DEFAULT_DOCK_TABS])}>Reset tabs</Button>}>
		<SettingsRow as="label" className="settings-row--preference" title="Open app to">
			<span className="settings-preference-control settings-preference-control--select">
				<select aria-label="Open app to" className="settings-preference-input" value={preferences.defaultScreen}
					onChange={event => onChange({ defaultScreen: event.currentTarget.value as PwaPreferences['defaultScreen'] })}>
					<option value="today">Today</option>
					<option value="inbox">Inbox</option>
					<option value="upcoming">Upcoming</option>
					<option value="browse">Projects</option>
					<option value="reading">Reading</option>
					<option value="favorites">Favorites</option>
					<option value="archive">Archive</option>
				</select>
				<ChevronDown size={14} aria-hidden="true" />
			</span>
		</SettingsRow>
		<Reorder.Group axis="y" values={tabs} onReorder={changeTabs} className="settings-tab-list" aria-label="Your tabs">
			{tabs.map(tab => <TabRow key={tab} tab={tab} tabs={tabs} onChange={changeTabs} description={description} />)}
		</Reorder.Group>
		<p id={description} className="settings-help settings-tabs-help">Select a tab to replace it. Drag to reorder.<span className="pwa-dock__sr"> You can also reorder with the Up and Down arrow keys.</span></p>
	</SettingsSection>;
}
