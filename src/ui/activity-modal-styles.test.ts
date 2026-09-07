import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('sync activity modal styles', () => {
	it('uses the same compact modal-header rhythm as reminder screens', async () => {
		const styles = await readFile(
			new URL('../styles/plugin/_activity.scss', import.meta.url),
			'utf8',
		);
		const syncButton = styles.match(/^\.crate-sync-now-btn \{([\s\S]*?)^\}/m)?.[1];

		expect(styles).toContain('--crate-activity-header-control-size: var(--clickable-icon-size');
		expect(styles).toContain('--crate-activity-space-inline: var(--size-4-4, 16px)');
		const component = await readFile(new URL('./activity/ActivitySheet.tsx', import.meta.url), 'utf8');
		expect(component).toContain('<ModalHeader title="Sync activity"');
		expect(styles).not.toContain('.crate-activity-close-btn');
		expect(syncButton).toContain('width: var(--crate-activity-header-control-size)');
		expect(styles).toContain('margin: 0 var(--crate-activity-space-inline) 16px');
		expect(styles).toContain('padding: 0 var(--crate-activity-space-inline) 20px');
	});
});
