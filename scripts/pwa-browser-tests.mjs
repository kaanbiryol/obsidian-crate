import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { readFileSync } from 'node:fs';

export const browserDurations = JSON.parse(readFileSync(new URL('./pwa-browser-durations.json', import.meta.url), 'utf8')).seconds;

export const browserScripts = [
	'scripts/react-shadow-dom-test.mjs',
	'scripts/base-ui-plugin-test.mjs',
	'scripts/pwa-storage-safety-test.mjs',
	'scripts/pwa-settings-test.mjs',
	'scripts/pwa-startup-empty-test.mjs',
	'scripts/pwa-schedule-test.mjs',
	'scripts/pwa-cache-test.mjs',
	'scripts/pwa-cache-recovery-test.mjs',
	'scripts/pwa-cache-recovery-ui-test.mjs',
	'scripts/pwa-outbox-recovery-test.mjs',
	'scripts/pwa-draft-recovery-test.mjs',
	'scripts/pwa-operation-expiry-test.mjs',
	'scripts/pwa-safe-area-test.mjs',
	'scripts/pwa-ios27-header-test.mjs',
	'scripts/pwa-focus-test.mjs',
	'scripts/pwa-sheet-field-test.mjs',
	'scripts/pwa-feature-switcher-test.mjs',
	'scripts/pwa-dock-test.mjs',
	'scripts/pwa-editor-contract-test.mjs',
	'scripts/pwa-editor-selection-test.mjs',
	'scripts/pwa-sheet-interaction-test.mjs',
	'scripts/pwa-chip-scroll-test.mjs',
	'scripts/pwa-drawer-swipe-test.mjs',
	'scripts/pwa-inline-delete-test.mjs',
	'scripts/pwa-sheet-transition-test.mjs',
	'scripts/pwa-sheet-mount-test.mjs',
	'scripts/pwa-sheet-opening-test.mjs',
	'scripts/pwa-ui-performance-test.mjs',
	'scripts/pwa-safety-test.mjs',
	'scripts/pwa-auth-recovery-test.mjs',
	'scripts/pwa-push-registration-test.mjs',
	'scripts/pwa-source-issues-test.mjs',
	'scripts/pwa-multitab-test.mjs',
	'scripts/pwa-clock-test.mjs',
	'scripts/pwa-optimistic-test.mjs',
	'scripts/pwa-install-test.mjs',
	'scripts/pwa-update-test.mjs',
	'scripts/pwa-update-notice-test.mjs',
	'scripts/pwa-capacity-test.mjs',
	'scripts/pwa-pagination-test.mjs',
	'scripts/pwa-reminder-scroll-test.mjs',
	'scripts/pwa-reorder-touch-test.mjs',
	'scripts/pwa-project-transition-test.mjs',
	'scripts/reading-touch-test.mjs',
	'scripts/reading-appearance-test.mjs',
	'scripts/shared-press-feedback-test.mjs',
];

// These checks exercise native menus, system-font geometry, or WebKit
// rendering/focus across page and viewport changes. Retain the release platform.
export const macosBrowserScripts = [
	'scripts/pwa-settings-test.mjs',
	'scripts/pwa-safe-area-test.mjs',
	'scripts/pwa-ios27-header-test.mjs',
	'scripts/pwa-editor-contract-test.mjs',
	'scripts/pwa-editor-selection-test.mjs',
	'scripts/pwa-sheet-interaction-test.mjs',
	'scripts/pwa-chip-scroll-test.mjs',
	'scripts/pwa-inline-delete-test.mjs',
	'scripts/pwa-sheet-opening-test.mjs',
	'scripts/pwa-safety-test.mjs',
	'scripts/pwa-update-test.mjs',
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
