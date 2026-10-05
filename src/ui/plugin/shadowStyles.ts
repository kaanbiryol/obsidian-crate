import type CratePlugin from '@/main';

const stylesheetCache = new WeakMap<CratePlugin, Promise<CSSStyleSheet>>();

async function getPluginStylesheet(plugin: CratePlugin): Promise<CSSStyleSheet> {
	const cached = stylesheetCache.get(plugin);
	if (cached) {
		return cached;
	}

	const stylesheetPromise = (async () => {
		const stylesPath = `${plugin.manifest.dir}/styles.css`;
		const cssText = await plugin.app.vault.adapter.read(stylesPath);
		const stylesheet = new CSSStyleSheet();
		stylesheet.replaceSync(cssText);
		return stylesheet;
	})();

	stylesheetCache.set(plugin, stylesheetPromise);
	return stylesheetPromise;
}

export async function attachPluginStylesheet(plugin: CratePlugin, shadowRoot: ShadowRoot): Promise<void> {
	const stylesheet = await getPluginStylesheet(plugin);
	if (shadowRoot.adoptedStyleSheets.includes(stylesheet)) {
		return;
	}

	shadowRoot.adoptedStyleSheets = [...shadowRoot.adoptedStyleSheets, stylesheet];
}
