import React, { useRef, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Notice, Platform } from 'obsidian';
import type CratePlugin from '../../plugin/CratePlugin';
import { BaseUiModal } from '../../ui/shared/BaseUiModal';
import { hideNativeModalCloseButton } from '../../reminders/ui/adapters/modalShell';
import { getReadingLibrary } from '../runtime';
import { ReadingDialog } from './ReadingDialog';
import { SaveLinkForm } from './SaveLinkForm';
import { ThemeIconProvider } from '../../reminders/components/theme-icon';
import { ObsidianIcon } from '../../reminders/components/obsidian-icon';

/** The command uses Obsidian's modal shell with the same capture fields as the PWA. */
export class AddReadingLinkModal extends BaseUiModal {
	private root?: Root;
	constructor(private plugin: CratePlugin) { super(plugin.app); }
	onOpen(): void {
		this.modalEl.addClass('crate-reminder-editor-modal');
		this.modalEl.toggleClass('is-mobile', Platform.isMobile);
		hideNativeModalCloseButton(this.modalEl);
		this.contentEl.addClasses(['crate-reminder-editor-modal__content', 'crate-reminders-ui']);
		this.root = createRoot(this.contentEl);
		this.root.render(<ThemeIconProvider renderer={ObsidianIcon}><LocalCapture plugin={this.plugin} onClose={() => this.close()} /></ThemeIconProvider>);
	}
	onClose(): void { this.root?.unmount(); this.root = undefined; this.contentEl.empty(); }
}

function LocalCapture({ plugin, onClose }: { plugin: CratePlugin; onClose: () => void }) {
	const [url, setUrl] = useState(''), [title, setTitle] = useState('');
	const [saving, setSaving] = useState(false), [error, setError] = useState<string | null>(null);
	const pending = useRef(false);
	const save = async () => {
		if (pending.current) return;
		pending.current = true; setSaving(true); setError(null);
		try {
			const library = getReadingLibrary(plugin);
			if (!library) throw new Error('Enable reading in Crate settings first.');
			const result = await library.add(url, title);
			new Notice(result.duplicate ? 'This link is already saved.' : 'Link saved to your reading inbox.'); onClose();
		} catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not save this link.'); }
		finally { pending.current = false; setSaving(false); }
	};
	return <ReadingDialog title="Save a link" busy={saving} onClose={onClose}><SaveLinkForm url={url} title={title} onUrl={setUrl} onTitle={setTitle} saving={saving} error={error} onCancel={onClose} onSave={() => void save()} /></ReadingDialog>;
}
