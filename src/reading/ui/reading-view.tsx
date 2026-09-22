import React, { useRef, useState, useSyncExternalStore } from 'react';
import { ItemView, Notice, type WorkspaceLeaf } from 'obsidian';
import type CratePlugin from '../../plugin/CratePlugin';
import { createShadowReactMount, type ShadowReactMount } from '../../reminders/ui/adapters/shadowReactMount';
import { getReadingLibrary } from '../runtime';
import type { ReadingLibrary } from '../data/library';
import { ReadingLibraryPanel } from './ReadingLibrary';
import { ReadingReader } from './Reader';
import { ReadingDialog } from './ReadingDialog';
import { SaveLinkForm } from './SaveLinkForm';
import './reading.scss';
import { ThemeIconProvider } from '../../reminders/components/theme-icon';
import { ObsidianIcon } from '../../reminders/components/obsidian-icon';

export const READING_VIEW_TYPE = 'crate-reading';
export class ReadingView extends ItemView {
	private mount: ShadowReactMount | null = null;
	private active = false;
	constructor(leaf: WorkspaceLeaf, private plugin: CratePlugin) { super(leaf); }
	getViewType(): string { return READING_VIEW_TYPE; }
	getDisplayText(): string { return 'Reading'; }
	getIcon(): string { return 'book-open'; }
	async onOpen(): Promise<void> {
		const library = getReadingLibrary(this.plugin);
		if (!library) { this.leaf.detach(); return; }
		this.active = true;
		this.contentEl.empty(); this.contentEl.addClass('crate-reading-view');
		const host = this.contentEl.createDiv({ cls: 'crate-reading-view' });
		this.mount = await createShadowReactMount(this.plugin, host, { mountClassName: 'crate-reading-mount', isActive: () => this.active });
		if (this.mount) this.mount.render(<ThemeIconProvider renderer={ObsidianIcon}><LocalReadingLibrary plugin={this.plugin} library={library} /></ThemeIconProvider>);
	}
	async onClose(): Promise<void> { this.active = false; this.mount?.unmount(); this.mount = null; }
}

function LocalReadingLibrary({ plugin, library }: { plugin: CratePlugin; library: ReadingLibrary }) {
	const snapshot = useSyncExternalStore(library.subscribe, library.getSnapshot);
	const [article, setArticle] = useState<Awaited<ReturnType<ReadingLibrary['read']>> | null>(null);
	const [adding, setAdding] = useState(false), [url, setUrl] = useState(''), [title, setTitle] = useState('');
	const [saving, setSaving] = useState(false), [error, setError] = useState<string | null>(null);
	const pending = useRef(false);
	const item = article && (snapshot.items.find(item => item.crate_reading_id === article.item.crate_reading_id) ?? article.item);
	return <><ReadingLibraryPanel snapshot={snapshot}
		onAdd={() => { setError(null); setAdding(true); }}
		onOpen={async item => { setArticle(await library.read(item)); }}
		onUpdate={(item, changes) => library.update(item, changes)}
		onRefresh={() => library.refresh()} onSettings={() => plugin.openSettingsTab()} activeId={item?.crate_reading_id}
		reader={article && item && <ReadingReader item={item} markdown={article.markdown} status="Saved in your vault" onUpdate={async changes => { await library.update(item, changes); const updated = await library.read({ ...item, ...changes }); setArticle(current => current?.item.crate_reading_id === item.crate_reading_id ? updated : current); }} onBack={() => setArticle(null)} onEdit={() => { void plugin.app.workspace.openLinkText(item.path, '', true).catch(() => { new Notice('Could not open the reading note. It may have moved.'); }); }} />} />
		{adding && <ReadingDialog title="Save a link" busy={saving} onClose={() => setAdding(false)}><SaveLinkForm url={url} title={title} onUrl={setUrl} onTitle={setTitle} saving={saving} error={error} onCancel={() => setAdding(false)} onSave={() => {
			if (pending.current) return;
			pending.current = true; setSaving(true); setError(null);
			void library.add(url, title).then(result => { setAdding(false); setUrl(''); setTitle(''); new Notice(result.duplicate ? 'This link is already saved.' : 'Link saved to your reading inbox.'); })
				.catch((cause: unknown) => setError(cause instanceof Error ? cause.message : 'Could not save this link.'))
				.finally(() => { pending.current = false; setSaving(false); });
		}} /></ReadingDialog>}
	</>;
}
