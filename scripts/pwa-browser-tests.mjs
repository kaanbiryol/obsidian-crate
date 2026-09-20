import { spawnSync } from 'node:child_process';

const scripts = [
	'scripts/react-shadow-dom-test.mjs',
	'scripts/base-ui-plugin-test.mjs',
	'scripts/pwa-storage-safety-test.mjs',
	'scripts/pwa-startup-empty-test.mjs',
	'scripts/pwa-cache-test.mjs',
	'scripts/pwa-cache-recovery-test.mjs',
	'scripts/pwa-cache-recovery-ui-test.mjs',
	'scripts/pwa-outbox-recovery-test.mjs',
	'scripts/pwa-draft-recovery-test.mjs',
	'scripts/pwa-operation-expiry-test.mjs',
	'scripts/pwa-safe-area-test.mjs',
	'scripts/pwa-focus-test.mjs',
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
	'scripts/pwa-capacity-test.mjs',
	'scripts/pwa-pagination-test.mjs',
	'scripts/pwa-reminder-scroll-test.mjs',
	'scripts/pwa-reorder-touch-test.mjs',
	'scripts/pwa-project-transition-test.mjs',
];

const failures = [];
for (const script of scripts) {
	console.log(`\nRunning ${script}`);
	const result = spawnSync(process.execPath, [script], { stdio: 'inherit' });
	if (result.signal) {
		console.error(`${script} terminated by ${result.signal}`);
		process.exit(1);
	}
	if (result.error || result.status !== 0) {
		failures.push(script);
		if (result.error) console.error(result.error);
	}
}
if (failures.length > 0) {
	console.error(`\nBrowser checks failed (${failures.length}/${scripts.length}):\n${failures.join('\n')}`);
	process.exitCode = 1;
} else {
	console.log(`\nAll ${scripts.length} browser checks passed.`);
}
