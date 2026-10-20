import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { readFileSync } from 'node:fs';

export const browserDurations = JSON.parse(readFileSync(new URL('./pwa-browser-durations.json', import.meta.url), 'utf8')).seconds;

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
	'tests/browser/pwa/pwa-clock-test.mjs',
	'tests/browser/pwa/pwa-optimistic-test.mjs',
	'tests/browser/pwa/pwa-install-test.mjs',
	'tests/browser/pwa/pwa-update-test.mjs',
	'tests/browser/pwa/pwa-update-notice-test.mjs',
	'tests/browser/pwa/pwa-capacity-test.mjs',
	'tests/browser/pwa/pwa-pagination-test.mjs',
	'tests/browser/pwa/pwa-reminder-scroll-test.mjs',
	'tests/browser/pwa/pwa-reorder-touch-test.mjs',
	'tests/browser/pwa/pwa-project-transition-test.mjs',
	'tests/browser/reading/reading-touch-test.mjs',
	'tests/browser/reading/reading-appearance-test.mjs',
	'tests/browser/plugin/shared-press-feedback-test.mjs',
];

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

export function runBrowserTests(scripts, { run = spawnSync, env = process.env, logger = console } = {}) {
	// A shard owns its checkout: build fresh assets before any child can reuse them.
	const build = run(process.execPath, ['scripts/build-worker.mjs'], { stdio: 'inherit', env });
	if (build.error || build.signal || build.status !== 0) {
		logger.error('PWA build failed; browser checks were not started.', build.error ?? build.signal ?? build.status);
		return 1;
	}
	const failures = [];
	for (const script of scripts) {
		logger.log(`\nRunning ${script}`);
		const started = performance.now();
		const result = run(process.execPath, [script], { stdio: 'inherit', env: { ...env, CRATE_PWA_PREBUILT: '1' } });
		logger.log(`${script}: ${((performance.now() - started) / 1000).toFixed(1)}s`);
		if (result.signal) {
			logger.error(`${script} terminated by ${result.signal}`);
			return 1;
		}
		if (result.error || result.status !== 0) {
			failures.push(script);
			if (result.error) logger.error(result.error);
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
	const { values } = parseArgs({ options: { shard: { type: 'string' }, platform: { type: 'string' }, list: { type: 'boolean' } } });
	const scripts = selectScripts(values.shard, values.platform);
	if (values.list) console.log(scripts.join('\n'));
	else process.exitCode = runBrowserTests(scripts);
}
