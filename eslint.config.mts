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
						'vite.config.mts',
						'vitest.config.ts',
						'site/assets/*.js',
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
			'obsidianmd/ui/sentence-case': [2, { ignoreWords: [
				'Cloudflare',
				'Crate',
				'D1',
				'Durable',
				'GitHub',
				'HTTPS',
				'Obsidian',
				'OAuth',
				'Objects',
				'R2',
				'Worker',
			] }],
		},
	},
	{
		files: [
			'src/cloudflare/callback-page.test.ts',
			'src/cloudflare/worker/pwa.test.ts',
		],
		rules: {
			'import/no-nodejs-modules': 'off',
		},
	},
	{
		files: [
			'src/pwa/**/*.{ts,tsx}',
			'src/cloudflare/worker/setup-client.js',
		],
		rules: {
			'no-restricted-globals': 'off',
			'no-restricted-imports': ['error', {
				paths: [{
					name: '@/reminders/ui/plugin/PluginRemindersAppShell',
					message: 'The PWA owns its application shell; share panels, cards, and view-model logic instead.',
				}],
			}],
			'obsidianmd/platform': 'off',
			'@typescript-eslint/no-deprecated': 'off',
			'@typescript-eslint/no-misused-promises': 'off',
		},
	},
	{
		files: ['src/reminders/core/**/*.{ts,tsx}'],
		rules: {
			'no-restricted-imports': ['error', {
				paths: [{
					name: 'obsidian',
					message: 'reminders/core must stay platform-neutral so it can be shared by the plugin and Worker.',
				}],
			}],
		},
	},
	globalIgnores([
		"node_modules",
		"node_modules/**",
		"dist",
		"dist/**",
		".generated",
		".generated/**",
		"test-vault",
		"test-vault/**",
		"esbuild.config.mjs",
		"eslint.config.js",
		"deploy.local.json",
		"deploy.yml",
		"version-bump.mjs",
		"versions.json",
		"main.js",
	]),
);
