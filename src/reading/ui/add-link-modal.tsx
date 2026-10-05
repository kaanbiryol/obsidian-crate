import type { ReadingItem } from '../core/model';
import React, { useRef, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Notice, Platform } from 'obsidian';
import type CratePlugin from '../../plugin/CratePlugin';
import { BaseUiModal } from '../../ui/plugin/BaseUiModal';
import { hideNativeModalCloseButton } from '../../ui/plugin/modalShell';
import { getReadingLibrary } from '../runtime';
import { SaveLinkDialog } from './SaveLinkDialog';
import { ThemeIconProvider } from '@/ui/shared/ThemeIcon';
import { ObsidianIcon } from '@/ui/obsidian-icon';

/** Plugin capture uses Obsidian's modal shell with the same capture fields as the PWA. */
export class AddReadingLinkModal extends BaseUiModal {
	private root?: Root;
	constructor(private plugin: CratePlugin, private onExisting?: (item: ReadingItem) => Promise<void>) { super(plugin.app); }
	onOpen(): void {
		this.modalEl.addClass('crate-reminder-editor-modal');
		this.modalEl.toggleClass('is-mobile', Platform.isMobile);
		hideNativeModalCloseButton(this.modalEl);
		this.contentEl.addClasses(['crate-reminder-editor-modal__content', 'crate-reminders-ui']);
		this.root = createRoot(this.contentEl);
		this.root.render(<ThemeIconProvider renderer={ObsidianIcon}><LocalCapture onExisting={this.onExisting} plugin={this.plugin} onClose={() => this.close()} /></ThemeIconProvider>);
	}
	onClose(): void { this.root?.unmount(); this.root = undefined; this.contentEl.empty(); }
}

function LocalCapture({ plugin, onClose, onExisting }: { plugin: CratePlugin; onClose: () => void; onExisting?: (item: ReadingItem) => Promise<void> }) {
	const [url, setUrl] = useState('');
	const [saving, setSaving] = useState(false), [error, setError] = useState<string | null>(null);
	const pending = useRef(false);
	const save = async () => {
		if (pending.current) return;
		pending.current = true; setSaving(true); setError(null);
		try {
			const library = getReadingLibrary(plugin);
			if (!library) throw new Error('Reading is still starting. Try saving again shortly.');
			const result = await library.add(url, undefined, true);
			if (result.duplicate) await onExisting?.(result.item);
			new Notice(result.duplicate ? 'This link is already saved.' : 'Link saved to your reading inbox.'); onClose();
		} catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not save this link.'); }
		finally { pending.current = false; setSaving(false); }
	};
	return <SaveLinkDialog captureOnDevice variant={Platform.isMobile ? 'bottom-sheet' : 'centered'} showBackdrop={Platform.isMobile}
		url={url} onUrl={setUrl} saving={saving} error={error} onClose={onClose} onSave={() => void save()} />;
}
