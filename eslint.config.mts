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
						'vite.config.mts',
						'vitest.cloudflare.config.ts',
						'vitest.config.ts',
						'site/assets/*.js',
					]
				},
				tsconfigRootDir: import.meta.dirname,
				extraFileExtensions: ['.json']
			},
		},
	},
	...obsidianmd.configs.recommended,
	{
		files: ['scripts/**/*.mjs', 'vite.config.mts', 'vitest.cloudflare.config.ts', 'vitest.config.ts'],
		extends: [tseslint.configs.disableTypeChecked],
		languageOptions: {
			globals: {
				...globals.node,
			},
			parserOptions: {
				projectService: false,
			},
		},
	},
	{
		files: ['eslint.config.mts'],
		rules: {
			'@typescript-eslint/no-unsafe-argument': 'off',
		},
	},
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
			'obsidianmd/no-nodejs-modules': 'off',
		},
	},
	{
		files: [
			'scripts/**/*.{js,mjs}',
			'site/**/*.js',
			'src/cloudflare/worker/**/*.{ts,tsx}',
			'src/pwa/**/*.{ts,tsx}',
			'src/test/**/*.{ts,tsx}',
			'src/**/*.test.{ts,tsx}',
			'vite.config.mts',
			'vitest.cloudflare.config.ts',
			'vitest.config.ts',
		],
		rules: {
			'no-restricted-globals': 'off',
			'no-unsanitized/method': 'off',
			'obsidianmd/hardcoded-config-path': 'off',
			'obsidianmd/no-global-this': 'off',
				'obsidianmd/no-nodejs-modules': 'off',
				'obsidianmd/no-plugin-as-component': 'off',
				'obsidianmd/no-unsupported-api': 'off',
				'obsidianmd/no-view-references-in-plugin': 'off',
			'obsidianmd/platform': 'off',
			'obsidianmd/prefer-create-el': 'off',
			'obsidianmd/prefer-file-manager-trash-file': 'off',
			'obsidianmd/prefer-instanceof': 'off',
			'obsidianmd/prefer-window-timers': 'off',
			'obsidianmd/rule-custom-message': 'off',
			'obsidianmd/settings-tab/no-deprecated-display': 'off',
			'obsidianmd/settings-tab/no-manual-html-headings': 'off',
			'obsidianmd/settings-tab/no-problematic-settings-headings': 'off',
			'obsidianmd/settings-tab/prefer-setting-definitions': 'off',
			'obsidianmd/settings-tab/prefer-update-over-display': 'off',
			'obsidianmd/settings-tab/require-display': 'off',
			'obsidianmd/ui/sentence-case': 'off',
		},
	},
	{
		files: [
			'src/pwa/**/*.{ts,tsx}',
			'src/cloudflare/worker/setup-client.js',
		],
		rules: {
			'no-restricted-globals': 'off',
			'@typescript-eslint/no-restricted-imports': ['error', {
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
			'@typescript-eslint/no-restricted-imports': ['error', {
				paths: [{
					name: 'obsidian',
					message: 'reminders/core must stay platform-neutral so it can be shared by the plugin and Worker.',
				}],
			}],
		},
	},
	{
		files: ['src/sync/planner-helpers.ts'],
		rules: {
			'obsidianmd/prefer-file-manager-trash-file': 'off',
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
