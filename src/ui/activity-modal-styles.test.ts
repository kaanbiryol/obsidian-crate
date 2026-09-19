import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('sync activity modal styles', () => {
	it('uses the same compact modal-header rhythm as reminder screens', async () => {
		const styles = await readFile(
			new URL('../styles/plugin/_activity.scss', import.meta.url),
			'utf8',
		);

		expect(styles).not.toContain('padding-block: 2px');
		expect(styles).toContain('--crate-activity-space-inline: var(--size-4-4, 16px)');
		const component = await readFile(new URL('./activity/ActivitySheet.tsx', import.meta.url), 'utf8');
		expect(component).toContain('<ModalHeader title="Sync activity"');
		expect(styles).not.toContain('.crate-activity-close-btn');
		expect(styles).not.toMatch(/^\.crate-sync-now-btn\s*\{/m);
		expect(styles).toContain('width: min(800px, calc(100vw - 48px))');
		expect(styles).toContain('max-width: 800px');
		expect(styles).toContain('height: min(560px, calc(100dvh - 48px))');
		expect(styles).toContain('padding-inline: var(--crate-activity-space-inline)');
		expect(styles).toContain('padding: 0 var(--crate-activity-space-inline) 20px');
	});

	it('shares the primary action treatment with conflict resolution', async () => {
		const [styles, activity, conflictReview] = await Promise.all([
			readFile(new URL('../styles/plugin/_activity.scss', import.meta.url), 'utf8'),
			readFile(new URL('./activity-modal.ts', import.meta.url), 'utf8'),
			readFile(new URL('./activity/conflict-review-modal.ts', import.meta.url), 'utf8'),
		]);
		expect(activity).toContain('crate-sync-now-btn crate-sync-primary-action reminder-modal-header-action');
		expect(conflictReview).toContain("primary.addClass('crate-conflict-primary-action', 'crate-sync-primary-action')");
		expect(styles).toContain('.crate-reminders-ui button.crate-sync-primary-action {');
	});
});
