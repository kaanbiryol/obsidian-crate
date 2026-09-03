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
    expect(editorStyles).toContain('background: var(--crate-control-hover-bg)');
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
    const themeStyles = await readFile(
      new URL('../../styles/plugin-ui/_theme.scss', import.meta.url),
      'utf8',
    );
    const editorHeader = styles.match(/\.reminder-modal-header \{([\s\S]*?)\n\}/)?.[1];
    const headerSide = styles.match(/\.reminder-modal-header-side \{([\s\S]*?)\n\}/)?.[1];
    const headerCopy = styles.match(/\.reminder-modal-header-copy \{([\s\S]*?)\n\}/)?.[1];
    const headerIcon = styles.match(/\.reminder-modal-header-icon \{([\s\S]*?)\n\}/)?.[1];
    const iconButton = themeStyles.match(/\.crate-icon-button \{([\s\S]*?)\n\s{2}\}/)?.[1];
    const headerAction = styles.match(/\.reminder-modal-header-action \{([\s\S]*?)\n\}/)?.[1];
    const removeButton = styles.match(/^\.picker-remove-button \{([\s\S]*?)^\}/m)?.[1];

    expect(editorHeader).toContain('--reminder-modal-header-control-size: var(--crate-icon-button-size)');
    expect(editorHeader).toContain('grid-template-columns: var(--reminder-modal-header-control-size) minmax(0, 1fr) auto');
    expect(editorHeader).toContain('min-height: 44px');
    expect(headerSide).toContain('width: 100%');
    expect(headerSide).toContain('justify-content: flex-start');
    expect(headerSide).toContain('justify-content: flex-end');
    expect(headerSide).toContain('gap: var(--size-4-2, 8px)');
    expect(headerIcon).toContain('--crate-icon-button-control-size: var(--reminder-modal-header-control-size)');
    expect(iconButton).toContain('padding: 0');
    expect(headerCopy).toContain('text-align: left');
    expect(headerAction).toContain('border: 0 !important');
    expect(headerAction).toContain('box-shadow: none !important');
    expect(styles).toContain('@container (max-width: 420px)');
    expect(removeButton).toContain('width: fit-content');
    expect(removeButton).toContain('align-self: flex-start');
  });

  it('keeps the reminder delete icon quiet until its destructive hover state', async () => {
    const styles = await readFile(
      new URL('../../styles/plugin-ui/_reminder-editor.scss', import.meta.url),
      'utf8',
    );
    const themeStyles = await readFile(
      new URL('../../styles/plugin-ui/_theme.scss', import.meta.url),
      'utf8',
    );
    const deleteButton = styles.match(
      /\.reminder-header-delete \{([\s\S]*?)\n\}/,
    )?.[1];

    expect(deleteButton).toContain('color: var(--text-faint)');
    expect(themeStyles).toContain('.crate-icon-button');
    expect(themeStyles).toContain('background: transparent');
    expect(themeStyles).toContain('background: var(--crate-control-hover-bg)');
    expect(themeStyles).toContain('&[data-tone="danger"]:hover:not(:disabled)');
    expect(themeStyles).toContain('color: var(--crate-danger)');
  });

  it('keeps the disabled reminder submit action borderless', async () => {
    const styles = await readFile(
      new URL('../../styles/plugin-ui/_reminder-editor.scss', import.meta.url),
      'utf8',
    );
    const submitButton = styles.match(
      /^\.reminder-modal-header-action \{(?=\n\s{2}min-width: 0)([\s\S]*?)^\}/m,
    )?.[1];
    const disabledSubmitButton = submitButton?.match(
      /&:disabled \{([\s\S]*?)\}/,
    )?.[1];

    expect(submitButton).toContain('border: 0 !important');
    expect(submitButton).toContain('box-shadow: none !important');
    expect(disabledSubmitButton).toContain('border: 0 !important');
    expect(disabledSubmitButton).toContain('background: transparent !important');
    expect(disabledSubmitButton).toContain('box-shadow: none !important');
    expect(submitButton).toContain('&.is-enabled');
    expect(submitButton).toContain('height: var(--reminder-modal-header-control-size)');
    expect(submitButton).toContain('font-weight: var(--reminder-font-weight-medium)');
    expect(submitButton).toContain('background: transparent');
    expect(submitButton).toContain('color: var(--crate-accent-text)');
    expect(submitButton).toContain('color-mix(in srgb, var(--crate-accent-text) 9%, transparent)');
  });

  it('keeps reminder descriptions visually subordinate to their titles', async () => {
    const styles = await readFile(
      new URL('../../styles/plugin-ui/_reminder-editor.scss', import.meta.url),
      'utf8',
    );
    const description = styles.match(
      /\.reminder-description-input \{([\s\S]*?)\n\}/,
    )?.[1];

    expect(description).toContain('color: var(--text-muted)');
    expect(description).toContain('color: var(--text-faint)');
    expect(description).toContain('font-size: var(--reminder-font-sm)');
  });

  it('uses compact, restrained styling for the schedule picker', async () => {
    const styles = await readFile(
      new URL('../../styles/plugin-ui/_reminder-editor.scss', import.meta.url),
      'utf8',
    );
    const modalStyles = await readFile(
      new URL('../../styles/plugin-ui/_modal.scss', import.meta.url),
      'utf8',
    );

    expect(styles).toContain('.reminder-modal-header');
    expect(styles).not.toContain('.reminder-date-picker .reminder-modal-header');
    expect(styles).toContain('min-height: 44px');
    expect(styles).toContain('.picker-content');
    expect(styles).toContain('.picker-current-value');
    expect(styles).toContain('background: color-mix(in srgb, var(--crate-semantic-color) 6%, transparent)');
    expect(styles).toContain('border: 0');
    expect(styles).toContain('.reminder-date-picker .date-quick-button');
    expect(styles).toContain('border: 1px solid color-mix(in srgb, var(--crate-divider) 55%, transparent)');
    expect(styles).toContain('.reminder-date-picker .picker-schedule-fields');
    expect(styles).toContain('border: 0');
    expect(styles).toContain('.picker-control-row');
    expect(styles).toContain('min-height: var(--crate-picker-row-height)');
    expect(styles).toContain('height: var(--crate-picker-input-height)');
    expect(styles).toContain(':is(.picker-date-input, .picker-time-input).has-value');
    expect(styles).toContain('.reminder-date-picker .picker-remove-button');
    expect(styles).toContain('min-height: 32px');
    expect(modalStyles).toContain('.crate-reminder-editor-surface,\n.crate-reminder-picker-surface.is-date-picker');
    expect(modalStyles).toContain('width: min(560px, calc(100vw - 40px))');
    expect(modalStyles).toContain('.crate-reminder-editor-surface.is-centered,\n.crate-reminder-picker-surface.is-date-picker.is-centered');
  });

  it('aligns the project picker shell and rows with the reminder editor', async () => {
    const styles = await readFile(
      new URL('../../styles/plugin-ui/_reminder-editor.scss', import.meta.url),
      'utf8',
    );
    const modalStyles = await readFile(
      new URL('../../styles/plugin-ui/_modal.scss', import.meta.url),
      'utf8',
    );
    const projectRow = styles.match(
      /^\.project-picker-row \{([\s\S]*?)^\}/m,
    )?.[1];

    expect(modalStyles).toContain('.crate-reminder-picker-surface.is-project-picker');
    expect(modalStyles).toContain('width: min(560px, calc(100vw - 40px))');
    expect(projectRow).toContain('min-height: 40px');
    expect(projectRow).toContain('border: 1px solid transparent');
    expect(projectRow).toContain('border-radius: var(--crate-radius-control)');
    expect(projectRow).toContain('var(--project-picker-row-accent) 16%');
    expect(projectRow).toContain('var(--project-picker-row-accent) 7%');
    expect(styles).toContain('color: var(--project-picker-row-accent)');
    expect(styles).toContain('scroll-padding: 8px');
  });

  it('uses compact, semantic controls for the recurrence picker', async () => {
    const styles = await readFile(
      new URL('../../styles/plugin-ui/_reminder-editor.scss', import.meta.url),
      'utf8',
    );
    const modalStyles = await readFile(
      new URL('../../styles/plugin-ui/_modal.scss', import.meta.url),
      'utf8',
    );
    const themeStyles = await readFile(
      new URL('../../styles/plugin-ui/_theme.scss', import.meta.url),
      'utf8',
    );
    const content = styles.match(/^\.picker-content \{([\s\S]*?)^\}/m)?.[1];
    const sectionHeading = styles.match(/^\.picker-section-heading \{([\s\S]*?)^\}/m)?.[1];
    const controlRow = styles.match(/^\.picker-control-row \{([\s\S]*?)^\}/m)?.[1];
    const tabs = styles.match(/^\.recurrence-frequency-tabs \{([\s\S]*?)^\}/m)?.[1];
    const frequencyButton = styles.match(/^\.recurrence-frequency-button \{([\s\S]*?)^\}/m)?.[1];
    const optionRow = styles.match(/^\.recurrence-option-row \{([\s\S]*?)^\}/m)?.[1];
    const stepperButton = styles.match(/^\.recurrence-stepper-button \{([\s\S]*?)^\}/m)?.[1];
    const dayButton = styles.match(/^\.recurrence-day-button \{([\s\S]*?)^\}/m)?.[1];

    expect(modalStyles).toContain('.crate-reminder-picker-surface.is-recurrence-picker');
    expect(modalStyles).toContain('width: min(560px, calc(100vw - 40px))');
    expect(content).toContain('gap: var(--crate-picker-space-section)');
    expect(content).toContain('padding: var(--crate-picker-space-section) var(--crate-picker-space-inline) 2px');
    expect(sectionHeading).toContain('font-size: var(--reminder-font-xxs)');
    expect(sectionHeading).toContain('font-weight: var(--reminder-font-weight-medium)');
    expect(controlRow).toContain('min-height: var(--crate-picker-row-height)');
    expect(controlRow).toContain('gap: var(--crate-picker-space-control)');
    expect(tabs).toContain('gap: 3px');
    expect(tabs).toContain('border-radius: var(--crate-radius-control)');
    expect(frequencyButton).toContain('min-height: 34px');
    expect(frequencyButton).toContain('var(--crate-warning) 9%');
    expect(optionRow).toContain('flex: 0 0 auto');
    expect(stepperButton).toContain('--crate-icon-button-control-size: 28px');
    expect(themeStyles).toContain('&[data-size="small"]');
    expect(dayButton).toContain('height: 32px');
    expect(dayButton).toContain('var(--crate-warning) 8%');
    expect(styles).toContain('.reminder-recurrence-picker .picker-time-input');
    expect(styles).toContain('.reminder-recurrence-picker .picker-remove-button');
  });

  it('uses one spacing and typography contract across reminder picker screens', async () => {
    const styles = await readFile(
      new URL('../../styles/plugin-ui/_reminder-editor.scss', import.meta.url),
      'utf8',
    );

    expect(styles).not.toContain('.recurrence-picker-content');
    expect(styles).not.toContain('.reminder-date-picker .picker-section-heading');
    expect(styles).not.toContain('.reminder-recurrence-picker .picker-section-heading');
    expect(styles).not.toContain('.reminder-date-picker .picker-field-copy strong');
    expect(styles).not.toContain('.reminder-recurrence-picker .picker-field-copy strong');
    expect(styles).toContain('margin: 8px var(--crate-picker-space-inline) 10px');
    expect(styles).toContain('padding: 0 var(--crate-picker-space-inline)');
  });

  it('keeps the dialog title and editable reminder text one typography step apart', async () => {
    const styles = await readFile(
      new URL('../../styles/plugin-ui/_reminder-editor.scss', import.meta.url),
      'utf8',
    );
    const headerTitle = styles.match(
      /\.reminder-modal-header-title \{([\s\S]*?)\n\}/,
    )?.[1];
    const titleInput = styles.match(
      /\.reminder-editor-fields \.reminder-title-input \{([\s\S]*?)\n\}/,
    )?.[1];

    expect(headerTitle).toContain('font-size: var(--reminder-font-base)');
    expect(headerTitle).toContain('font-weight: var(--reminder-font-weight-medium)');
    expect(titleInput).toContain('font-size: var(--reminder-font-editor-title)');
    expect(titleInput).toContain('font-weight: var(--reminder-font-weight-semibold)');
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

    expect(chipLayout).toContain('display: inline');
    expect(chipLayout).not.toMatch(/^\s*height:/m);
    expect(chipLayout).not.toContain('align-items:');
    expect(chipLayout).toContain('margin: 0 0.08em');
    expect(chipLayout).toContain(
      'font-size: clamp(var(--reminder-font-base), 0.92em, var(--reminder-font-editor-title))',
    );
    expect(chipLayout).toContain('line-height: var(--reminder-line-height-tight)');
    expect(chipLayout).toContain('vertical-align: baseline');
    expect(dateChip).toContain('padding: 0.05em 0.4em');
    expect(dateChip).toContain('width: 0.9em');
    expect(dateChip).toContain('height: 0.9em');
    expect(dateChip).toContain('margin-right: 0.25em');
    expect(dateChip).toContain('vertical-align: -0.1em');
    expect(dateChip).toContain('color: var(--crate-accent-text)');
    expect(dateChip).not.toContain('var(--crate-success)');
    expect(projectChip).toContain('padding: 0.05em 0.4em');
    expect(projectChip).toContain('width: 0.9em');
    expect(projectChip).toContain('height: 0.9em');
    expect(projectChip).toContain('margin-right: 0.25em');
    expect(projectChip).toContain('vertical-align: -0.1em');
    expect(projectChip).toContain(
      'color: var(--reminder-project-color, var(--crate-accent-text))',
    );
    expect(priorityChip).toContain('width: 1.2em');
    expect(priorityChip).toContain('display: inline-block');
    expect(priorityChip).toContain('border: 0');
    expect(priorityChip).toContain(
      'background: color-mix(in srgb, var(--crate-danger) 7%, transparent)',
    );
  });

  it('keeps unset properties neutral and colors selected property values', async () => {
    const styles = await readFile(
      new URL('../../styles/plugin-ui/_reminder-editor.scss', import.meta.url),
      'utf8',
    );
    const themeStyles = await readFile(
      new URL('../../styles/plugin-ui/_theme.scss', import.meta.url),
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
    expect(actionChips).toContain('gap: 4px');
    expect(actionChip).toContain('margin: 0 !important');
    expect(actionChip).toContain('--reminder-action-chip-height: max(');
    expect(actionChip).toContain('min-height: var(--reminder-action-chip-height)');
    expect(actionChip).toContain('gap: 0.3em');
    expect(actionChip).toContain('padding: 0 0.375em');
    expect(actionChip).toContain('border-radius: var(--crate-radius-control)');
    expect(themeStyles).toContain('--crate-semantic-color: var(--crate-accent-text)');
    expect(themeStyles).toContain(
      '--crate-semantic-color: var(--reminder-project-color, var(--crate-accent-text))',
    );
    expect(themeStyles).toContain('--crate-semantic-color: var(--crate-danger)');
    expect(themeStyles).toContain('--crate-semantic-color: var(--crate-warning)');
    expect(actionChip).toContain(
      'border: 1px solid color-mix(in srgb, var(--crate-divider) 35%, transparent)',
    );
    expect(actionChip).toContain('background: transparent');
    expect(actionChip).toContain('color: var(--text-faint)');
    expect(actionChip).toContain('font-size: var(--reminder-font-sm)');
    expect(actionChip).toContain('line-height: var(--reminder-line-height-tight)');
    expect(actionChip).toContain('background: var(--crate-semantic-bg)');
    expect(actionChip).toContain('color: var(--crate-semantic-color)');
    expect(actionChip).toContain('var(--crate-control-hover-bg)');
    expect(actionChip).toContain('outline: 2px solid var(--crate-focus-ring)');
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
    expect(editorStyles).toContain('padding: 8px 12px 12px');
    expect(editorStyles).toContain('min-height: var(--reminder-action-chip-height)');
    expect(editorStyles).toContain('height: 40px');
    expect(editorStyles).toContain('vertical-align: baseline');
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
    expect(interactionStyles).toContain(
      '.reminders-view.light:is(.is-inbox, .is-today, .is-upcoming, .is-browse, .is-project-detail)',
    );
    expect(interactionStyles).toContain('--crate-reminder-card-bg: var(--background-primary)');
    expect(interactionStyles).toContain(
      '--crate-reminder-card-border: color-mix(in srgb, var(--text-normal) 9%, transparent)',
    );
    expect(interactionStyles).toContain('color: var(--text-muted)');
    expect(interactionStyles).toContain('--crate-card-press-duration: 45ms');
    expect(interactionStyles).toContain(
      'transition-duration: var(--crate-card-press-duration)',
    );
    expect(projectCard).not.toContain('whileTap');
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
