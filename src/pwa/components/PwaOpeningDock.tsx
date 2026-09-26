import React from 'react';
import { createPwaOpeningDockHtml } from '../opening-dock';
import type { StartTab } from '../types';

export function PwaOpeningDock({ tab }: { tab: StartTab | 'reading' }) {
	return <div className="pwa-opening-dock-mount" dangerouslySetInnerHTML={{ __html: createPwaOpeningDockHtml(tab) }} />;
}
