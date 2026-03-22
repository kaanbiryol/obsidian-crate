import { heroui } from "@heroui/react";
import { sharedHeroUITheme } from "./tailwind.theme.js";

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
	plugins: [heroui({ themes: sharedHeroUITheme })],
	corePlugins: {
		preflight: false,
	},
};
