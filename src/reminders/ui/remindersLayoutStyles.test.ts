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
    expect(themeStyles).toContain('--crate-picker-selection-bg: var(--crate-selection-bg)');
    expect(themeStyles).toContain('--crate-tab-active-bg: var(--crate-selection-bg)');
    expect(themeStyles).toContain('--crate-icon-button-size: var(--clickable-icon-size');
    expect(themeStyles).toContain('--reminder-font-base: var(--font-ui-medium');
    expect(themeStyles).toContain('--crate-motion-duration-fast: var(--anim-duration-fast');
    expect(modalStyles).toContain('backdrop-filter: var(--crate-modal-backdrop-filter)');
    expect(modalStyles).not.toContain('backdrop-filter: blur(8px)');
    expect(editorStyles).toContain('background: var(--crate-control-active-bg)');
    expect(editorStyles).toContain('color: var(--text-normal)');
    expect(editorStyles).toContain('background: var(--crate-picker-selection-bg)');
    expect(editorStyles).not.toContain('transition: all');
  });

  it('keeps the reminder editor overlay independent of native modal transforms', async () => {
    const dialogStyles = await readFile(
      new URL('../../styles/plugin/_dialogs.scss', import.meta.url),
      'utf8',
    );
    const editorHost = dialogStyles.match(
      /\.modal\.crate-reminder-editor-modal \{([\s\S]*?)\n\}/,
    )?.[1];

    expect(editorHost).toBeDefined();
    expect(editorHost).toContain('position: fixed !important');
    expect(editorHost).toContain('inset: 0 !important');
    expect(editorHost).toContain('width: auto !important');
    expect(editorHost).toContain('transform: none !important');
  });

  it('keeps editor actions aligned and uses the compact spacing at sheet widths', async () => {
    const styles = await readFile(
      new URL('../../styles/plugin-ui/_reminder-editor.scss', import.meta.url),
      'utf8',
    );
    const headerSide = styles.match(/\.reminder-editor-header-side \{([\s\S]*?)\n\}/)?.[1];
    const headerIcon = styles.match(/\.reminder-header-icon \{([\s\S]*?)\n\}/)?.[1];
    const pickerHeaderAction = styles.match(/\.picker-header-action \{([\s\S]*?)\n\}/)?.[1];
    const removeButton = styles.match(/\.picker-remove-button \{([\s\S]*?)\n\}/)?.[1];

    expect(headerSide).toContain('width: 100%');
    expect(headerSide).toContain('justify-content: flex-start');
    expect(headerSide).toContain('justify-content: flex-end');
    expect(headerIcon).toContain('padding: 0');
    expect(pickerHeaderAction).toContain('border: 0 !important');
    expect(pickerHeaderAction).toContain('box-shadow: none !important');
    expect(styles).toContain('@container (max-width: 600px)');
    expect(removeButton).toContain('width: fit-content');
    expect(removeButton).toContain('align-self: flex-start');
  });

  it('keeps the reminder delete icon quiet until its destructive hover state', async () => {
    const styles = await readFile(
      new URL('../../styles/plugin-ui/_reminder-editor.scss', import.meta.url),
      'utf8',
    );
    const deleteButton = styles.match(
      /\.reminder-header-delete \{([\s\S]*?)\n\}/,
    )?.[1];

    expect(deleteButton).toContain('border: 0');
    expect(deleteButton).toContain('background: transparent');
    expect(deleteButton).toContain('color: var(--text-faint)');
    expect(deleteButton).toContain('background: var(--crate-control-hover-bg)');
    expect(deleteButton).toContain('color: var(--crate-danger)');
  });

  it('keeps the disabled reminder submit action borderless', async () => {
    const styles = await readFile(
      new URL('../../styles/plugin-ui/_reminder-editor.scss', import.meta.url),
      'utf8',
    );
    const submitButton = styles.match(
      /^\.reminder-header-submit \{(?=\n\s{2}min-width: 52px)([\s\S]*?)^\}/m,
    )?.[1];
    const disabledSubmitButton = submitButton?.match(
      /&:disabled \{([\s\S]*?)\}/,
    )?.[1];

    expect(submitButton).toContain('border: 0 !important');
    expect(submitButton).toContain('box-shadow: none !important');
    expect(disabledSubmitButton).toContain('border: 0 !important');
    expect(disabledSubmitButton).toContain('background: transparent !important');
    expect(disabledSubmitButton).toContain('box-shadow: none !important');
  });

  it('keeps reminder descriptions visually subordinate to their titles', async () => {
    const styles = await readFile(
      new URL('../../styles/plugin-ui/_reminder-editor.scss', import.meta.url),
      'utf8',
    );
    const description = styles.match(
      /\.reminder-description-input \{([\s\S]*?)\n\}/,
    )?.[1];

    expect(description).toContain('color: var(--text-faint)');
  });

  it('shows the reminder title placeholder when the rich text field is empty', async () => {
    const styles = await readFile(
      new URL('../../styles/plugin-ui/_reminder-editor.scss', import.meta.url),
      'utf8',
    );
    const titleInput = styles.match(
      /\.reminder-editor-fields \.reminder-title-input \{([\s\S]*?)\n\}/,
    )?.[1];

    expect(titleInput).toContain('&:empty::before');
    expect(titleInput).toContain('content: attr(data-placeholder)');
    expect(titleInput).toContain('pointer-events: none');
  });

  it('keeps inline reminder chips evenly sized and vertically centered', async () => {
    const styles = await readFile(
      new URL('../../styles/plugin-ui/_reminder-editor.scss', import.meta.url),
      'utf8',
    );
    const chipLayout = styles.match(
      /\.reminder-editor-fields \.reminder-title-input :is\(([\s\S]*?)\) \{([\s\S]*?)\n\}/,
    )?.[2];
    const dateChip = styles.match(
      /\.reminder-editor-fields \.reminder-title-input \.rich-text-chip-date \{([\s\S]*?)\n\}/,
    )?.[1];
    const projectChip = styles.match(
      /\.reminder-editor-fields \.reminder-title-input \.rich-text-chip-project \{([\s\S]*?)\n\}/,
    )?.[1];
    const priorityChip = styles.match(
      /\.reminder-editor-fields \.reminder-title-input \.rich-text-chip-priority \{([\s\S]*?)\n\}/,
    )?.[1];

    expect(chipLayout).toContain('display: inline-flex');
    expect(chipLayout).toContain('height: 32px');
    expect(chipLayout).toContain('align-items: center');
    expect(chipLayout).toContain('margin: 2px 1px');
    expect(chipLayout).toContain('font-size: calc(var(--reminder-font-base) + 1px)');
    expect(chipLayout).toContain('line-height: 1');
    expect(chipLayout).toContain('vertical-align: middle');
    expect(dateChip).toContain('padding: 0 9px');
    expect(dateChip).toContain('width: 1em');
    expect(dateChip).toContain('height: 1em');
    expect(dateChip).toContain('flex: 0 0 auto');
    expect(projectChip).toContain('padding: 0 9px');
    expect(projectChip).toContain('width: 1em');
    expect(projectChip).toContain('height: 1em');
    expect(projectChip).toContain('flex: 0 0 auto');
    expect(priorityChip).toContain('width: 32px');
    expect(priorityChip).toContain('justify-content: center');
  });

  it('does not draw a divider between the description and reminder actions', async () => {
    const styles = await readFile(
      new URL('../../styles/plugin-ui/_reminder-editor.scss', import.meta.url),
      'utf8',
    );
    const actionChips = styles.match(
      /^\.reminder-action-chips \{([\s\S]*?)^\}/m,
    )?.[1];
    const actionChip = styles.match(
      /^\.reminder-action-chip \{([\s\S]*?)^\}/m,
    )?.[1];

    expect(actionChips).toBeDefined();
    expect(actionChips).not.toContain('&::before');
    expect(actionChips).toContain('gap: 8px');
    expect(actionChip).toContain('margin: 0 !important');
  });

  it('keeps the reminder editor vertical rhythm compact', async () => {
    const editorStyles = await readFile(
      new URL('../../styles/plugin-ui/_reminder-editor.scss', import.meta.url),
      'utf8',
    );
    const modalStyles = await readFile(
      new URL('../../styles/plugin-ui/_modal.scss', import.meta.url),
      'utf8',
    );

    expect(editorStyles).toContain('min-height: 32px');
    expect(editorStyles).toContain('padding: 12px 18px 14px');
    expect(editorStyles).toContain('height: 40px');
    expect(editorStyles).toContain('vertical-align: middle');
    expect(modalStyles).toContain('.crate-reminder-editor-surface.is-centered');
    expect(modalStyles).toContain('padding-bottom: 8px');
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
    expect(cardStyles).toContain('right: -38px');
    expect(cardStyles).not.toContain('min-height: 80px');
  });

  it('scales the reminder card and its reorder handle as one pressed item', async () => {
    const primaryStyles = await readFile(
      new URL('./shared/styles/_primary-screen.scss', import.meta.url),
      'utf8',
    );
    const reorderableComponent = await readFile(
      new URL('../components/ReorderableReminderList.tsx', import.meta.url),
      'utf8',
    );

    expect(reorderableComponent).toContain(
      'whileTap={usesLongPress || reduceMotion ? undefined : { scale: 0.99 }}',
    );
    expect(primaryStyles).toContain(
      '.reorderable-reminder-item[data-reorder-interaction="handle"]',
    );
    expect(primaryStyles).toContain(
      '.premium-reminder-card:active .premium-reminder-content {\n        transform: none;',
    );
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
});
