import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('plugin reminder layout styles', () => {
  it('keeps the sidebar tab bar in flex flow above the scrolling content', async () => {
    const styles = await readFile(
      new URL('./reminders-view/_layout-modes.scss', import.meta.url),
      'utf8',
    );
    const sidebarBlock = styles.match(
      /\.reminders-view:not\(\.is-modal\):not\(\.is-fullscreen\):not\(\.is-compact\) \{([\s\S]*?)\n\}\n\n\/\/ Modal-specific/,
    )?.[1];

    expect(sidebarBlock).toBeDefined();
    expect(sidebarBlock).toContain('--reminders-tabbar-overlay: 0px');
    expect(sidebarBlock).toContain('--reminders-tabbar-bottom-offset: 0px');
    expect(sidebarBlock).toContain('.animated-tab-bar-bottom');
    expect(sidebarBlock).toContain('position: relative');
    expect(sidebarBlock).not.toContain('position: absolute');
  });

  it('allows the panel height chain to shrink around the tab bar', async () => {
    const styles = await readFile(
      new URL('./shared/styles/_shell.scss', import.meta.url),
      'utf8',
    );
    const panelBlock = styles.match(/\.reminders-view-panel \{([\s\S]*?)\n\}/)?.[1];

    expect(panelBlock).toContain('min-height: 0');
    expect(panelBlock).toContain('overflow: hidden');
  });
});
