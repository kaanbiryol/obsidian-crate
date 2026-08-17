import { heroui } from "@heroui/react";
import { sharedHeroUITheme } from "./tailwind.theme.js";

const CRATE_UI_SELECTOR = ".crate-reminders-ui";
const HEROUI_THEME_SELECTORS = new Set(Object.keys(sharedHeroUITheme).map((name) => `.${name}`));

function scopeHeroUIBaseSelector(selector) {
	return selector
		.split(",")
		.map((part) => part.trim())
		.map((part) => {
			if (part === ":root") return CRATE_UI_SELECTOR;
			if (part.startsWith("[data-theme")) return `${CRATE_UI_SELECTOR}${part}`;
			return `${CRATE_UI_SELECTOR} ${part}`;
		})
		.join(", ");
}

function scopeHeroUIPlugin(plugin) {
	return {
		...plugin,
		handler(api) {
			plugin.handler({
				...api,
				addBase(styles) {
					api.addBase(Object.fromEntries(
						Object.entries(styles).map(([selector, rules]) => [
							scopeHeroUIBaseSelector(selector),
							rules,
						]),
					));
				},
				addUtilities(utilities, options) {
					const scopedThemes = {};
					const remainingUtilities = {};

					for (const [selector, rules] of Object.entries(utilities)) {
						if (HEROUI_THEME_SELECTORS.has(selector)) {
							scopedThemes[
								`${CRATE_UI_SELECTOR}${selector}, ${CRATE_UI_SELECTOR} ${selector}`
							] = rules;
						} else {
							remainingUtilities[selector] = rules;
						}
					}

					api.addBase(scopedThemes);
					api.addUtilities(remainingUtilities, options);
				},
			});
		},
	};
}

/** @type {import('tailwindcss').Config} */
export default {
	content: [
		"./src/**/*.{js,ts,jsx,tsx}",
		"./node_modules/@heroui/theme/dist/**/*.{js,ts,jsx,tsx}",
	],
	safelist: [
		'bg-primary-50',
		'bg-secondary-50',
		'bg-success-50',
		'bg-warning-50',
		'bg-danger-50',
		'dark:bg-primary-500/20',
		'dark:bg-secondary-500/20',
		'dark:bg-success-500/20',
		'dark:bg-warning-500/20',
		'dark:bg-danger-500/20',
		'text-primary-600',
		'text-secondary-600',
		'text-success-600',
		'text-warning-600',
		'text-danger-600',
		'dark:text-primary-400',
		'dark:text-secondary-400',
		'dark:text-success-400',
		'dark:text-warning-400',
		'dark:text-danger-400',
	],
	theme: {
		extend: {},
	},
	darkMode: ["class", ".theme-dark"],
	plugins: [scopeHeroUIPlugin(heroui({ themes: sharedHeroUITheme }))],
};
