import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('sync activity modal styles', () => {
	it('uses the same compact modal-header rhythm as reminder screens', async () => {
		const styles = await readFile(
			new URL('../styles/plugin/_activity.scss', import.meta.url),
			'utf8',
		);
		const header = styles.match(/^\.crate-activity-header \{([\s\S]*?)^\}/m)?.[1];
		const title = styles.match(/^\.crate-activity-title \{([\s\S]*?)^\}/m)?.[1];
		const closeButton = styles.match(/^\.crate-activity-close-btn \{([\s\S]*?)^\}/m)?.[1];
		const syncButton = styles.match(/^\.crate-sync-now-btn \{([\s\S]*?)^\}/m)?.[1];

		expect(styles).toContain('--crate-activity-header-control-size: var(--clickable-icon-size');
		expect(styles).toContain('--crate-activity-space-inline: var(--size-4-4, 16px)');
		expect(header).toContain('min-height: 44px');
		expect(header).toContain('padding: 4px 10px');
		expect(title).toContain('font-size: var(--font-ui-medium, var(--font-text-size))');
		expect(title).toContain('font-weight: var(--font-medium)');
		expect(closeButton).toContain('width: var(--crate-activity-header-control-size)');
		expect(syncButton).toContain('width: var(--crate-activity-header-control-size)');
		expect(styles).toContain('margin: 0 var(--crate-activity-space-inline) 10px');
		expect(styles).toContain('padding: 4px var(--crate-activity-space-inline) 14px');
	});
});
