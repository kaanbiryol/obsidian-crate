import { expect, it, vi } from 'vitest';
import { attachPluginStylesheet } from './shadowStyles';

class FakeSheet { css = ''; replaceSync(text: string) { this.css = text; } }
function windowDocument() {
	class Sheet extends FakeSheet {}
	return { defaultView: { CSSStyleSheet: Sheet } } as unknown as Document;
}
const root = (ownerDocument: Document) => ({ ownerDocument, adoptedStyleSheets: [] as CSSStyleSheet[] }) as unknown as ShadowRoot;

it('adopts one stylesheet per window, built by that window, from one read of the plugin CSS', async () => {
	const read = vi.fn(async () => '.crate {}');
	const plugin = { manifest: { dir: '.obsidian/plugins/crate' }, app: { vault: { adapter: { read } } } } as never;
	const main = windowDocument(), popout = windowDocument();
	const [first, second, inPopout] = [root(main), root(main), root(popout)];
	for (const shadowRoot of [first, second, inPopout, first]) await attachPluginStylesheet(plugin, shadowRoot);
	expect(read).toHaveBeenCalledOnce();
	expect(first.adoptedStyleSheets).toHaveLength(1);
	expect(second.adoptedStyleSheets[0]).toBe(first.adoptedStyleSheets[0]);
	expect(inPopout.adoptedStyleSheets[0]).not.toBe(first.adoptedStyleSheets[0]);
	expect(inPopout.adoptedStyleSheets[0]).toBeInstanceOf((popout.defaultView as unknown as { CSSStyleSheet: typeof FakeSheet }).CSSStyleSheet);
});

it('reads the plugin CSS again after a failed read', async () => {
	const read = vi.fn().mockRejectedValueOnce(new Error('Unavailable')).mockResolvedValue('.crate {}');
	const plugin = { manifest: { dir: '.obsidian/plugins/crate' }, app: { vault: { adapter: { read } } } } as never;
	await expect(attachPluginStylesheet(plugin, root(windowDocument()))).rejects.toThrow('Unavailable');
	const shadowRoot = root(windowDocument());
	await attachPluginStylesheet(plugin, shadowRoot);
	expect(shadowRoot.adoptedStyleSheets).toHaveLength(1);
});
