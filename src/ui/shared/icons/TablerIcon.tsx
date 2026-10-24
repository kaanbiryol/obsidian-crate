import React from 'react';
import { TABLER_ICONS } from './tabler-icons.generated';

export interface TablerIconProps extends Omit<React.SVGProps<SVGSVGElement>, 'children' | 'dangerouslySetInnerHTML'> {
	size?: number | string;
}

export type IconComponent = React.ComponentType<TablerIconProps>;

/** Draws a bundled Tabler outline icon by Crate icon id; unknown ids render nothing. */
export function TablerIcon({ name, size = 24, strokeWidth = 2, ...props }: TablerIconProps & { name: string }) {
	const body = TABLER_ICONS[name];
	if (!body) return null;
	// The markup is generated at build time from @tabler/icons, never from user data.
	return <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
		strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" {...props} dangerouslySetInnerHTML={{ __html: body }} />;
}

function icon(name: string): IconComponent {
	const Icon = (props: TablerIconProps) => <TablerIcon name={name} {...props} />;
	Icon.displayName = `TablerIcon(${name})`;
	return Icon;
}

export const Bell = icon('bell');
export const Check = icon('check');
export const ChevronDown = icon('chevron-down');
export const ChevronRight = icon('chevron-right');
export const ChevronsUpDown = icon('chevrons-up-down');
export const Download = icon('download');
export const ExternalLink = icon('external-link');
export const GripVertical = icon('grip-vertical');
export const KeyRound = icon('key-round');
export const Link2Off = icon('link-2-off');
export const LogOut = icon('log-out');
export const Monitor = icon('monitor');
export const Moon = icon('moon');
export const RefreshCw = icon('refresh-cw');
export const ShieldCheck = icon('shield-check');
export const Sun = icon('sun');
export const TriangleAlert = icon('triangle-alert');
export const WifiOff = icon('wifi-off');
