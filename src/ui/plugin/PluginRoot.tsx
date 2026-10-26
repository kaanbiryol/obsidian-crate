import type React from 'react';
import type CratePlugin from '@/plugin/CratePlugin';
import { PluginContext } from '@/reminders/ui/plugin/reminders-context';
import { ThemeIconProvider } from '@/ui/shared/ThemeIcon';
import { ObsidianIcon } from '@/ui/obsidian-icon';

/** What every plugin React root provides: the plugin, and Obsidian's icons for shared components. */
export function PluginRoot({ plugin, children }: { plugin: CratePlugin; children: React.ReactNode }) {
	return <PluginContext.Provider value={plugin}><ThemeIconProvider renderer={ObsidianIcon}>{children}</ThemeIconProvider></PluginContext.Provider>;
}
