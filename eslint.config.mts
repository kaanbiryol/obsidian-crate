import tseslint from 'typescript-eslint';
import obsidianmd from "eslint-plugin-obsidianmd";
import globals from "globals";
import { globalIgnores } from "eslint/config";

export default tseslint.config(
	{
		languageOptions: {
			globals: {
				...globals.browser,
			},
			parserOptions: {
				projectService: {
					allowDefaultProject: [
						'eslint.config.mts',
						'manifest.json',
						'postcss.config.js',
						'tailwind.config.js',
						'tailwind.theme.js',
						'src/cloudflare/worker/pwa-client.tsx',
						'src/cloudflare/worker/pwa-client/components/*.tsx',
						'vite.config.mts',
						'vitest.config.ts',
					]
				},
				tsconfigRootDir: import.meta.dirname,
				extraFileExtensions: ['.json']
			},
		},
	},
	{
		files: ['scripts/**/*.mjs', 'vite.config.mts', 'vitest.config.ts'],
		languageOptions: {
			globals: {
				...globals.node,
			},
		},
	},
	...obsidianmd.configs.recommended,
	{
		files: ['**/*.{ts,tsx,mts}'],
		plugins: { obsidianmd },
		rules: {
			'no-undef': 'off',
			'obsidianmd/ui/sentence-case': [2, { ignoreWords: ['Cloudflare', 'R2', 'D1'] }],
		},
	},
	{
		files: ['src/cloudflare/worker/pwa-client.tsx', 'src/cloudflare/worker/pwa-client/**/*.{ts,tsx}'],
		rules: {
			'no-restricted-globals': 'off',
			'obsidianmd/platform': 'off',
			'@typescript-eslint/no-deprecated': 'off',
			'@typescript-eslint/no-misused-promises': 'off',
		},
	},
	globalIgnores([
		"node_modules",
		"dist",
		"esbuild.config.mjs",
		"eslint.config.js",
		"version-bump.mjs",
		"versions.json",
		"main.js",
	]),
);
