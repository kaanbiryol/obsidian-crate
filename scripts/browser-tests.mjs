import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { readFileSync } from 'node:fs';

export const browserDurations = JSON.parse(readFileSync(new URL('./browser-durations.json', import.meta.url), 'utf8')).seconds;

export const browserScripts = [
	'tests/browser/reading/reading-content-security-test.mjs',
	'tests/browser/pwa/pwa-encryption-test.mjs',
	'tests/browser/pwa/pwa-reading-encryption-test.mjs',
	'tests/browser/pwa/pwa-reading-encryption-storage-test.mjs',
	'tests/browser/pwa/pwa-web-app-unlock-test.mjs',
	'tests/browser/pwa/pwa-encryption-onboarding-test.mjs',
	'tests/browser/pwa/pwa-pairing-test.mjs',
	'tests/browser/pwa/pwa-encryption-regressions-test.mjs',
	'tests/browser/pwa/pwa-encryption-storage-test.mjs',
	'tests/browser/plugin/react-shadow-dom-test.mjs',
	'tests/browser/plugin/base-ui-plugin-test.mjs',
	'tests/browser/pwa/pwa-storage-safety-test.mjs',
	'tests/browser/pwa/pwa-settings-test.mjs',
	'tests/browser/pwa/pwa-sync-coordinator-test.mjs',
	'tests/browser/pwa/pwa-startup-empty-test.mjs',
	'tests/browser/pwa/pwa-schedule-test.mjs',
	'tests/browser/pwa/pwa-cache-test.mjs',
	'tests/browser/pwa/pwa-cache-recovery-test.mjs',
	'tests/browser/pwa/pwa-cache-recovery-ui-test.mjs',
	'tests/browser/pwa/pwa-outbox-recovery-test.mjs',
	'tests/browser/pwa/pwa-draft-recovery-test.mjs',
	'tests/browser/pwa/pwa-operation-expiry-test.mjs',
	'tests/browser/pwa/pwa-safe-area-test.mjs',
	'tests/browser/pwa/pwa-ios27-header-test.mjs',
	'tests/browser/pwa/pwa-focus-test.mjs',
	'tests/browser/pwa/pwa-sheet-field-test.mjs',
	'tests/browser/pwa/pwa-feature-switcher-test.mjs',
	'tests/browser/pwa/pwa-dock-test.mjs',
	'tests/browser/pwa/pwa-editor-contract-test.mjs',
	'tests/browser/pwa/pwa-editor-selection-test.mjs',
	'tests/browser/pwa/pwa-sheet-interaction-test.mjs',
	'tests/browser/pwa/pwa-chip-scroll-test.mjs',
	'tests/browser/pwa/pwa-drawer-swipe-test.mjs',
	'tests/browser/pwa/pwa-inline-delete-test.mjs',
	'tests/browser/pwa/pwa-sheet-transition-test.mjs',
	'tests/browser/pwa/pwa-sheet-mount-test.mjs',
	'tests/browser/pwa/pwa-sheet-opening-test.mjs',
	'tests/browser/pwa/pwa-ui-performance-test.mjs',
	'tests/browser/pwa/pwa-safety-test.mjs',
	'tests/browser/pwa/pwa-auth-recovery-test.mjs',
	'tests/browser/pwa/pwa-push-registration-test.mjs',
	'tests/browser/pwa/pwa-source-issues-test.mjs',
	'tests/browser/pwa/pwa-multitab-test.mjs',
	'tests/browser/pwa/pwa-reading-multitab-test.mjs',
	'tests/browser/pwa/pwa-clock-test.mjs',
	'tests/browser/pwa/pwa-optimistic-test.mjs',
	'tests/browser/pwa/pwa-install-test.mjs',
	'tests/browser/pwa/pwa-update-test.mjs',
	'tests/browser/pwa/pwa-update-notice-test.mjs',
	'tests/browser/pwa/pwa-capacity-test.mjs',
	'tests/browser/pwa/pwa-pagination-test.mjs',
	'tests/browser/pwa/pwa-reminder-scroll-test.mjs',
	'tests/browser/pwa/pwa-document-scroll-test.mjs',
	'tests/browser/pwa/pwa-reorder-touch-test.mjs',
	'tests/browser/pwa/pwa-project-transition-test.mjs',
	'tests/browser/reading/reading-touch-test.mjs',
	'tests/browser/reading/reading-appearance-test.mjs',
	'tests/browser/plugin/shared-press-feedback-test.mjs',
];

// Plugin UI groups run on their own (`--group <name>`) after `npm run build`; CI
// spreads them across the editor contract shards.
export const browserGroups = {
	activity: [
		'tests/browser/plugin/activity-empty-layout-test.mjs',
		'tests/browser/plugin/activity-diff-test.mjs',
		'tests/browser/plugin/activity-errors-test.mjs',
		'tests/browser/plugin/conflict-review-test.mjs',
	],
	'file-history': ['tests/browser/plugin/file-history-test.mjs'],
	'plugin-dialogs': ['tests/browser/plugin/plugin-dialogs-test.mjs', 'tests/browser/plugin/encryption-setup-test.mjs'],
};

// These checks exercise native menus, system-font geometry, or WebKit
// rendering/focus across page and viewport changes. Retain the release platform.
export const macosBrowserScripts = [
	'tests/browser/pwa/pwa-settings-test.mjs',
	'tests/browser/pwa/pwa-safe-area-test.mjs',
	'tests/browser/pwa/pwa-ios27-header-test.mjs',
	'tests/browser/pwa/pwa-focus-test.mjs',
	'tests/browser/pwa/pwa-feature-switcher-test.mjs',
	'tests/browser/pwa/pwa-dock-test.mjs',
	'tests/browser/pwa/pwa-editor-contract-test.mjs',
	'tests/browser/pwa/pwa-editor-selection-test.mjs',
	'tests/browser/pwa/pwa-sheet-interaction-test.mjs',
	'tests/browser/pwa/pwa-chip-scroll-test.mjs',
	'tests/browser/pwa/pwa-drawer-swipe-test.mjs',
	'tests/browser/pwa/pwa-inline-delete-test.mjs',
	'tests/browser/pwa/pwa-sheet-opening-test.mjs',
	'tests/browser/pwa/pwa-safety-test.mjs',
	'tests/browser/pwa/pwa-update-test.mjs',
];

export function selectScripts(shard, platform) {
	if (platform !== undefined && !['linux', 'macos'].includes(platform)) {
		throw new Error('Invalid browser platform; expected linux or macos.');
	}
	const scripts = browserScripts.filter(script => platform === undefined
		|| macosBrowserScripts.includes(script) === (platform === 'macos'));
	if (shard === undefined) return scripts;
	const match = /^([1-9]\d*)\/([1-9]\d*)$/.exec(shard);
	const [index, total] = match ? match.slice(1).map(Number) : [];
	if (!index || index > total || total > scripts.length) {
		throw new Error(`Invalid shard ${shard}; expected index/total with 1 <= index <= total <= ${scripts.length}`);
	}
	const groups = Array.from({ length: total }, () => ({ seconds: 0, scripts: new Set() }));
	const duration = script => browserDurations[script] ?? 30;
	for (const script of [...scripts].sort((a, b) => duration(b) - duration(a))) {
		const group = groups.reduce((smallest, candidate) => candidate.seconds < smallest.seconds ? candidate : smallest);
		group.scripts.add(script);
		group.seconds += duration(script);
	}
	// Preserve suite order within each group; timing estimates only decide placement.
	return scripts.filter(script => groups[index - 1].scripts.has(script));
}

export function selectGroup(name) {
	if (!Object.hasOwn(browserGroups, name)) {
		throw new Error(`Unknown browser group ${name}; expected one of ${Object.keys(browserGroups).join(', ')}.`);
	}
	return browserGroups[name];
}

export function runBrowserTests(scripts, { run = spawnSync, env = process.env, logger = console, buildWorker = true } = {}) {
	// A shard owns its checkout: build fresh assets before any child can reuse them.
	// Plugin groups use the plugin build instead of the Worker/PWA assets.
	const build = buildWorker ? run(process.execPath, ['scripts/build-worker.mjs'], { stdio: 'inherit', env }) : { status: 0 };
	if (build.error || build.signal || build.status !== 0) {
		logger.error('PWA build failed; browser checks were not started.', build.error ?? build.signal ?? build.status);
		return 1;
	}
	const failures = [];
	// CI retries a failed script once, matching the Playwright suites; the retry is logged as flaky.
	const attempts = env.CI ? 2 : 1;
	for (const script of scripts) {
		for (let attempt = 1; attempt <= attempts; attempt++) {
			logger.log(`\nRunning ${script}${attempt > 1 ? ` (retry ${attempt - 1})` : ''}`);
			const started = performance.now();
			const result = run(process.execPath, [script], { stdio: 'inherit', env: { ...env, CRATE_PWA_PREBUILT: '1' } });
			logger.log(`${script}: ${((performance.now() - started) / 1000).toFixed(1)}s`);
			if (result.signal) {
				logger.error(`${script} terminated by ${result.signal}`);
				return 1;
			}
			if (!result.error && result.status === 0) {
				if (attempt > 1) logger.error(`Flaky: ${script} passed on retry ${attempt - 1}.`);
				break;
			}
			if (result.error) logger.error(result.error);
			if (attempt === attempts) failures.push(script);
		}
	}
	if (failures.length > 0) {
		logger.error(`\nBrowser checks failed (${failures.length}/${scripts.length}):\n${failures.join('\n')}`);
		return 1;
	}
	logger.log(`\nAll ${scripts.length} browser checks passed.`);
	return 0;
}

if (import.meta.main) {
	const { values } = parseArgs({ options: { shard: { type: 'string' }, platform: { type: 'string' }, group: { type: 'string' }, list: { type: 'boolean' } } });
	if (values.group !== undefined && (values.shard !== undefined || values.platform !== undefined)) {
		throw new Error('--group cannot be combined with --shard or --platform.');
	}
	const scripts = values.group === undefined ? selectScripts(values.shard, values.platform) : selectGroup(values.group);
	if (values.list) console.log(scripts.join('\n'));
	else process.exitCode = runBrowserTests(scripts, { buildWorker: values.group === undefined });
}
