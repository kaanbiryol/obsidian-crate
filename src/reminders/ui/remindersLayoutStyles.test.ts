import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('plugin reminder layout styles', () => {
  it('maps custom surfaces and geometry to Obsidian theme tokens', async () => {
    const themeStyles = await readFile(
      new URL('../../styles/plugin-ui/_theme.scss', import.meta.url),
      'utf8',
    );
    const modalStyles = await readFile(
      new URL('../../styles/plugin-ui/_modal.scss', import.meta.url),
      'utf8',
    );
    const editorStyles = await readFile(
      new URL('../../styles/plugin-ui/_reminder-editor.scss', import.meta.url),
      'utf8',
    );

    expect(themeStyles).toContain('--crate-app-bg: var(--background-primary)');
    expect(themeStyles).toContain('--crate-modal-bg: var(--modal-background');
    expect(themeStyles).toContain('--background-modifier-form-field');
    expect(themeStyles).toContain('--crate-radius-button: var(--button-radius');
    expect(themeStyles).toContain('--crate-radius-sheet: var(--modal-radius');
    expect(themeStyles).toContain('--crate-elevation-sheet: var(--shadow-l');
    expect(themeStyles).toContain('--crate-selection-bg: var(--nav-item-background-active');
    expect(themeStyles).toContain('--crate-icon-button-size: var(--clickable-icon-size');
    expect(themeStyles).toContain('--reminder-font-base: var(--font-ui-medium');
    expect(themeStyles).toContain('--crate-motion-duration-fast: var(--anim-duration-fast');
    expect(modalStyles).toContain('backdrop-filter: var(--crate-modal-backdrop-filter)');
    expect(modalStyles).not.toContain('backdrop-filter: blur(8px)');
    expect(editorStyles).toContain('background: var(--crate-selection-bg)');
    expect(editorStyles).toContain('color: var(--crate-selection-color)');
  });

  it('uses Obsidian icon geometry instead of a bundled icon style', async () => {
    const iconStyles = await readFile(
      new URL('../components/obsidian-icon/styles.scss', import.meta.url),
      'utf8',
    );
    const iconComponent = await readFile(
      new URL('../components/obsidian-icon/index.tsx', import.meta.url),
      'utf8',
    );

    expect(iconStyles).toContain('--icon-size: var(--icon-m');
    expect(iconStyles).toContain('--icon-stroke: var(--icon-m-stroke-width');
    expect(iconComponent).toContain('setIcon(div.current, id)');
    expect(iconComponent).toContain('data-icon={id}');
  });

  it('does not force fixed pixel typography in plugin UI styles', async () => {
    const styleUrls = [
      '../../styles/plugin-ui/_theme.scss',
      '../../styles/plugin-ui/_modal.scss',
      '../../styles/plugin-ui/_reminder-editor.scss',
      '../../styles/plugin-ui/_calendar.scss',
      './shared/styles/_shell.scss',
      './shared/styles/_projects.scss',
      './shared/styles/_project-detail.scss',
      './shared/styles/_reminder-cards.scss',
      './shared/styles/_primary-screen.scss',
      './reminder-list/styles.scss',
    ];
    const styles = (await Promise.all(styleUrls.map((path) => (
      readFile(new URL(path, import.meta.url), 'utf8')
    )))).join('\n');

    expect(styles).not.toMatch(/font-size:\s*\d+(?:\.\d+)?px/);
    expect(styles).not.toMatch(/font-weight:\s*\d{3}/);
    expect(styles).not.toMatch(/letter-spacing:\s*-/);
  });

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
