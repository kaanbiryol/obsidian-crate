import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

async function readPluginThemeStyles() {
  const paths = ['../../styles/plugin-ui/_theme.scss', '../../ui/shared/styles/_tokens.scss', '../../ui/shared/styles/_controls.scss'];
  return (await Promise.all(paths.map(path => readFile(new URL(path, import.meta.url), 'utf8')))).join('\n');
}

async function readEditorStyles() {
  const paths = [
    '../../ui/shared/styles/_modal-header.scss',
    '../../styles/plugin-ui/_reminder-editor.scss',
    './shared/styles/_editor-fields.scss',
    './shared/styles/_editor-actions.scss',
    './shared/styles/_pickers.scss',
  ];
  return (await Promise.all(paths.map(path => readFile(new URL(path, import.meta.url), 'utf8')))).join('\n');
}

describe('plugin reminder layout styles', () => {
  it('maps custom surfaces and geometry to Obsidian theme tokens', async () => {
    const themeStyles = await readPluginThemeStyles();
    const modalStyles = await readFile(
      new URL('../../ui/shared/styles/_base-modal.scss', import.meta.url),
      'utf8',
    );
    const editorStyles = await readEditorStyles();

    expect(themeStyles).toContain('--crate-app-bg: var(--background-primary)');
    expect(themeStyles).toContain('--crate-modal-bg: var(--modal-background');
    expect(themeStyles).toContain('--background-modifier-form-field');
    expect(themeStyles).toContain('--crate-radius-button: var(--button-radius');
    expect(themeStyles).toContain('--crate-radius-sheet: var(--modal-radius');
    expect(themeStyles).toContain('--crate-elevation-sheet: var(--shadow-l');
    expect(themeStyles).toContain('--crate-selection-bg: var(--nav-item-background-active');
    expect(themeStyles).toContain('--crate-picker-selection-bg: var(--crate-selection-bg)');
    expect(themeStyles).toContain('--crate-tab-active-bg: var(--crate-selection-bg)');
    expect(themeStyles).toContain('--crate-icon-button-size: var(--clickable-icon-size');
    expect(themeStyles).toContain('--crate-accent-text: var(--text-accent');
    expect(themeStyles).toContain('--reminder-font-base: var(--font-ui-medium');
    expect(themeStyles).toContain('--reminder-font-title: var(--font-ui-large, var(--font-ui-medium))');
    expect(themeStyles).toContain('--reminder-font-editor-title: clamp(');
    expect(themeStyles).toContain('--crate-picker-space-inline: var(--size-4-4, 16px)');
    expect(themeStyles).toContain('--crate-picker-space-section: var(--size-4-4, 16px)');
    expect(themeStyles).toContain('--crate-picker-row-height: 40px');
    expect(themeStyles).toContain('--crate-picker-input-height: 30px');
    expect(themeStyles).toContain('--crate-motion-duration-fast: var(--anim-duration-fast');
    expect(modalStyles).toContain('backdrop-filter: var(--crate-modal-backdrop-filter)');
    expect(modalStyles).toContain('font-family: var(--reminder-font-ui)');
    expect(modalStyles).toContain('font-size: var(--reminder-font-base)');
    expect(modalStyles).not.toContain('backdrop-filter: blur(8px)');
    expect(editorStyles).toContain('--reminder-modal-header-control-size: var(--crate-icon-button-size)');
    expect(editorStyles).toContain('--crate-icon-button-control-size: var(--reminder-modal-header-control-size)');
    expect(editorStyles).toContain('background: var(--crate-control-hover-bg)');
    expect(editorStyles).toContain('color: var(--text-normal)');
    expect(editorStyles).toContain('background: var(--crate-picker-selection-bg)');
    expect(editorStyles).not.toContain('transition: all');
  });

  it('uses Obsidian checkbox and progress tokens without primary-screen overrides', async () => {
    const cardStyles = await readFile(
      new URL('./shared/styles/_reminder-cards.scss', import.meta.url),
      'utf8',
    );
    const primaryStyles = await readFile(
      new URL('./shared/styles/_primary-screen.scss', import.meta.url),
      'utf8',
    );

    expect(cardStyles).toContain('--checkbox-color');
    expect(cardStyles).toContain('--checkbox-marker-color');
    expect(cardStyles).toContain('--checkbox-border-color');
    expect(primaryStyles).not.toContain('--premium-checkbox-size: 18px');
    expect(primaryStyles).not.toContain('height: 3px');
  });

  it('uses one priority flag treatment for static and reorderable reminder cards', async () => {
    const cardStyles = await readFile(
      new URL('./shared/styles/_reminder-cards.scss', import.meta.url),
      'utf8',
    );
    const priorityFlagBlock = cardStyles.match(
      /^\.premium-priority-flag \{([\s\S]*?)^\}/m,
    )?.[1];

    expect(priorityFlagBlock).toBeDefined();
    expect(priorityFlagBlock).toContain('flex: 0 0 20px');
    expect(priorityFlagBlock).toContain('width: 20px');
    expect(priorityFlagBlock).toContain('height: 20px');
    expect(priorityFlagBlock).toContain('margin: 0');
    expect(priorityFlagBlock).toContain('border: 0');
    expect(priorityFlagBlock).toContain('background: transparent');
    expect(priorityFlagBlock).toContain('fill: currentColor');
    expect(cardStyles).not.toContain('&:has(.premium-priority-flag)');
    expect(cardStyles).not.toContain('.reorder-drag-handle');
    expect(cardStyles).not.toContain('padding-right: 56px');
    expect(cardStyles).not.toContain('min-height: 80px');
  });

  it('uses restrained Linear-style highlight and selection states for plugin cards', async () => {
    const interactionStyles = await readFile(
      new URL('./reminders-view/_card-interactions.scss', import.meta.url),
      'utf8',
    );
    const projectCard = await readFile(
      new URL('./views/BrowseProjectCard.tsx', import.meta.url),
      'utf8',
    );

    expect(interactionStyles).toContain('--crate-card-highlight-duration: 90ms');
    expect(interactionStyles).toContain('transform: none');
    expect(interactionStyles).not.toContain('translateY(');
    expect(interactionStyles).not.toContain('scale(');
    expect(interactionStyles).toContain(
      '.sidebar-reminder-card-wrapper:focus-visible .premium-reminder-content',
    );
    expect(interactionStyles).toContain(
      'box-shadow: inset 0 0 0 1px var(--crate-focus-ring)',
    );
    expect(interactionStyles).not.toContain('.reminders-view.light');
    expect(interactionStyles).toContain('--crate-card-press-duration: 45ms');
    expect(interactionStyles).toContain(
      'transition-duration: var(--crate-card-press-duration)',
    );
    expect(projectCard).not.toContain('whileTap');
  });

  it('uses Obsidian icon geometry instead of a bundled icon style', async () => {
    const iconStyles = await readFile(
      new URL('../../ui/obsidian-icon/styles.scss', import.meta.url),
      'utf8',
    );
    const iconComponent = await readFile(
      new URL('../../ui/obsidian-icon/index.tsx', import.meta.url),
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
      '../../ui/shared/styles/_modal-header.scss',
      './shared/styles/_editor-fields.scss',
      './shared/styles/_editor-actions.scss',
    './shared/styles/_pickers.scss',
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

  it('extends the sidebar tab bar behind the status bar and lifts its items', async () => {
    const styles = await readFile(
      new URL('./reminders-view/_layout-modes.scss', import.meta.url),
      'utf8',
    );
    const sidebarBlock = styles.match(
      /\.reminders-view:not\(\.is-modal\):not\(\.is-fullscreen\):not\(\.is-compact\) \{([\s\S]*?)\n\}\n\n\/\/ Modal-specific/,
    )?.[1];

    expect(sidebarBlock).toBeDefined();
    expect(sidebarBlock).toContain('--reminders-tabbar-overlay: var(--reminders-tabbar-height)');
    expect(sidebarBlock).toContain('--reminders-tabbar-bottom-offset: var(--reminders-host-bottom-inset, 0px)');
    expect(sidebarBlock).toContain('--reminders-safe-area: var(--reminders-tabbar-bottom-offset)');
    expect(sidebarBlock).toContain('max-width: none');
    expect(sidebarBlock).toContain('padding-bottom: var(--reminders-tabbar-bottom-offset)');
    expect(sidebarBlock).toContain('.animated-tab-bar-bottom');
    expect(sidebarBlock).toContain('position: absolute');
    expect(sidebarBlock).toContain('bottom: 0');
  });

  it('lets the plugin navigation fill its owned Obsidian view', async () => {
    const styles = await readFile(
      new URL('../../styles/plugin/_status.scss', import.meta.url),
      'utf8',
    );
    const viewContainerBlock = styles.match(
      /\.workspace-leaf-content\[data-type="reminders-view"\] > \.view-content\.crate-reminders-view-container \{([\s\S]*?)\n\}/,
    )?.[1];

    expect(viewContainerBlock).toBeDefined();
    expect(viewContainerBlock).toContain('padding: 0');
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

  it('keeps reminder card width stable while switching tabs', async () => {
    const styles = await readFile(
      new URL('./shared/styles/_shell.scss', import.meta.url),
      'utf8',
    );
    const transitionBlock = styles.match(
      /\.reminders-content \{([\s\S]*?)\/\/ Minimal scrollbar/,
    )?.[1];
    const scrollBlock = styles.match(
      /\.reminders-view-scroll \{([\s\S]*?)\n\}/,
    )?.[1];

    expect(transitionBlock).toBeDefined();
    expect(transitionBlock).not.toContain('overflow-y: hidden');
    expect(scrollBlock).toContain('scrollbar-gutter: stable');
  });
});
