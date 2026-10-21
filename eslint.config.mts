import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import obsidianmd from "eslint-plugin-obsidianmd";
import globals from "globals";
import { globalIgnores } from "eslint/config";
import workerImportBoundary from './scripts/worker-import-boundary.mjs';

const pluginAdapterImports = {
	regex: '^(?:@/ui/plugin|(?:\\.\\./)+(?:ui/)?plugin|(?:@/|(?:\\.\\./)+)reminders/ui/plugin)(?:/|$)',
	message: 'Obsidian adapters belong to the plugin host; use portable components from ui/shared.',
};

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
						'vite.config.mts',
						'vitest.cloudflare.config.ts',
						'vitest.config.ts',
					]
				},
				tsconfigRootDir: import.meta.dirname,
				extraFileExtensions: ['.json']
			},
		},
	},
	...obsidianmd.configs.recommended,
	{
		files: ['**/*.{ts,tsx,js,mjs,mts}'],
		plugins: { 'react-hooks': reactHooks },
		rules: {
			'react-hooks/rules-of-hooks': 'error',
			'react-hooks/exhaustive-deps': 'error',
		},
	},
	{
		files: ['scripts/**/*.mjs', 'tests/browser/**/*.mjs', 'packages/server/{src,test}/**/*.mjs', 'vite.visual.config.mts', 'playwright.config.ts', 'vite.config.mts', 'vitest.cloudflare.config.ts', 'vitest.config.ts'],
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
				'QR',
				'R2',
				'UTC',
				'Worker',
			] }],
		},
	},
	{
		files: [
			'src/cloudflare/callback-page.test.ts',
			'src/cloudflare/worker/pwa/index.test.ts',
		],
		rules: {
			'obsidianmd/no-nodejs-modules': 'off',
		},
	},
	{
		files: [
			'scripts/**/*.{js,mjs}',
			'tests/browser/**/*.mjs',
			'packages/server/{src,test}/**/*.mjs',
			'site/**/*.js',
			'src/cloudflare/worker/**/*.{ts,tsx}',
			'src/pwa/**/*.{ts,tsx}',
			'src/test/**/*.{ts,tsx}',
			'src/**/*.test.{ts,tsx}',
			'tests/**/*.{ts,tsx,mts}',
			'vite.visual.config.mts',
			'playwright.config.ts',
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
				}, {
					name: '@base-ui/react/button',
					message: 'Use ui/shared/Button or PwaButton so PWA actions share control behavior and styling.',
				}],
				patterns: [pluginAdapterImports],
			}],
			'obsidianmd/platform': 'off',
			'@typescript-eslint/no-deprecated': 'off',
			'@typescript-eslint/no-misused-promises': 'off',
		},
	},
	{
		files: ['src/ui/shared/**/*.{ts,tsx}', 'src/reminders/ui/{shared,reminder-editor,views,format}/**/*.{ts,tsx}', 'src/reading/ui/**/*.{ts,tsx}'],
		ignores: ['src/reading/ui/plugin/**'],
		rules: {
			'@typescript-eslint/no-restricted-imports': ['error', {
				paths: [{ name: 'obsidian', message: 'Shared UI must work in both the plugin and PWA; keep Obsidian APIs in ui/plugin.' }],
				patterns: [pluginAdapterImports],
			}],
		},
	},
	{
		files: ['src/cloudflare/worker/**/*.{ts,tsx}'],
		ignores: ['**/*.test.ts', '**/*.integration.ts', '**/*-test-harness.ts'],
		plugins: { crate: { rules: { 'worker-import-boundary': workerImportBoundary } } },
		rules: {
			'crate/worker-import-boundary': 'error',
		},
	},
	{
		// This shared capture deadline also runs in workerd, which has no window.
		files: ['src/reading/extraction/youtube-transcript.ts'],
		rules: { 'obsidianmd/prefer-window-timers': 'off' },
	},
	{
		// Shared by the plugin, PWA and Worker.
		files: [
			'src/reminders/{core,types}/**/*.{ts,tsx}',
			'src/reading/{core,extraction}/**/*.{ts,tsx}',
			'src/{protocol,encryption,platform}/**/*.{ts,tsx}',
		],
		rules: {
			'@typescript-eslint/no-restricted-imports': ['error', {
				paths: [{
					name: 'obsidian',
					message: 'Shared domain modules must stay platform-neutral so the plugin, PWA and Worker can use them.',
				}],
			}],
		},
	},
	{
		// Shared and inert document adapters cannot use Obsidian's element helpers.
		files: ['src/reading/ui/reader-highlights.ts', 'src/reading/extraction/**/*.ts'],
		rules: {
			'obsidianmd/prefer-create-el': 'off',
		},
	},
	{
		// The standalone visual fixture loads the selected host stylesheet explicitly.
		files: ['tests/visual/gallery/main.tsx', 'tests/editor-contract/fixture.tsx'],
		rules: { 'obsidianmd/no-forbidden-elements': 'off' },
	},
	{
		// Remote deletions must remain recoverable even when the user's host
		// preference is permanent deletion. Vault.trash(file, false) forces .trash.
		files: ['src/sync/local/local-delete.ts'],
		rules: { 'obsidianmd/prefer-file-manager-trash-file': 'off' },
	},
	{
		// Sync timers also run in Node-based unit tests.
		files: ['src/sync/**/*.{ts,tsx}'],
		rules: {
			'obsidianmd/prefer-window-timers': 'off',
		},
	},
	{
		// Crate's settings tab is a dynamic workflow with section-specific cleanup
		// and OAuth/device actions that are not representable as static controls.
		files: ['src/ui/settings-tab.ts'],
		rules: {
			'obsidianmd/settings-tab/prefer-setting-definitions': 'off',
		},
	},
	globalIgnores([
		"node_modules",
		"node_modules/**",
		"dist",
		"dist/**",
		".generated",
		".generated/**",
		"site/assets/*.generated.js",
		"site/shortcuts/help/**",
		// Starlight is a separate project, validated by npm run check:docs.
		"docs-site/**",
		"site/docs/**",
		"test-vault",
		"test-vault/**",
		// Agent worktrees are full repository copies with their own node_modules.
		".claude/**",
		"test-results/**",
		"playwright-report/**",
		"esbuild.config.mjs",
		"eslint.config.js",
		"deploy.yml",
		"version-bump.mjs",
		"versions.json",
		"main.js",
	]),
);
