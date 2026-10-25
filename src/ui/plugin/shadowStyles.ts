import type CratePlugin from '@/main';

const cssCache = new WeakMap<CratePlugin, Promise<string>>();
const sheetCache = new WeakMap<CratePlugin, WeakMap<Document, CSSStyleSheet>>();

function getPluginCss(plugin: CratePlugin): Promise<string> {
	const cached = cssCache.get(plugin);
	if (cached) return cached;
	const css = plugin.app.vault.adapter.read(`${plugin.manifest.dir}/styles.css`);
	cssCache.set(plugin, css);
	// A failed read is retried by the next mount instead of failing every later one.
	css.catch(() => { if (cssCache.get(plugin) === css) cssCache.delete(plugin); });
	return css;
}

/** A constructed stylesheet belongs to the document that created it, so each
 * window, including Obsidian popouts, adopts its own copy of the plugin CSS. */
export async function attachPluginStylesheet(plugin: CratePlugin, shadowRoot: ShadowRoot): Promise<void> {
	const cssText = await getPluginCss(plugin);
	const doc = shadowRoot.ownerDocument;
	let sheets = sheetCache.get(plugin);
	if (!sheets) {
		sheets = new WeakMap();
		sheetCache.set(plugin, sheets);
	}
	let stylesheet = sheets.get(doc);
	if (!stylesheet) {
		const Sheet = doc.defaultView?.CSSStyleSheet ?? CSSStyleSheet;
		stylesheet = new Sheet();
		stylesheet.replaceSync(cssText);
		sheets.set(doc, stylesheet);
	}
	if (shadowRoot.adoptedStyleSheets.includes(stylesheet)) return;
	shadowRoot.adoptedStyleSheets = [...shadowRoot.adoptedStyleSheets, stylesheet];
}
