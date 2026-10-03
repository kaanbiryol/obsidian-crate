import React, { useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { PluginReadingDialog, type ReadingDialogProps } from './ReadingDialog';

/** Keep overlays inside the pane, but outside its clipped tab and reader layers. */
export function ObsidianReadingDialog(props: ReadingDialogProps) {
	const marker = useRef<HTMLDivElement>(null);
	const [container, setContainer] = useState<HTMLElement | null>(null);
	useLayoutEffect(() => {
		const pane = marker.current?.closest('.plugin-workspace-navigation') ?? marker.current?.closest('.crate-reading-workspace');
		if (!pane) return;
		const overlay = pane.ownerDocument.createElement('div');
		overlay.className = 'crate-reading-pane-overlay';
		pane.append(overlay);
		setContainer(overlay);
		return () => overlay.remove();
	}, []);
	return <><div ref={marker} />{container && createPortal(<PluginReadingDialog {...props} contained />, container)}</>;
}
