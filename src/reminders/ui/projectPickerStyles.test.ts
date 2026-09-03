import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('project picker styles', () => {
  it('uses compact theme-aware selection without an accent rail', async () => {
    const pickerStyles = await readFile(
      new URL('../../styles/plugin-ui/_reminder-editor.scss', import.meta.url),
      'utf8',
    );
    const sharedStyles = await readFile(
      new URL('./shared/styles/_shell.scss', import.meta.url),
      'utf8',
    );
    const modalStyles = await readFile(
      new URL('../../styles/plugin-ui/_modal.scss', import.meta.url),
      'utf8',
    );

    const selectedRow = pickerStyles.match(
      /\.project-picker-row \{[\s\S]*?&\.is-selected \{([\s\S]*?)\n\s{2}\}/,
    )?.[1];
    const selectedSuggestion = sharedStyles.match(
      /&\[aria-selected="true"\] \{([\s\S]*?)\n\s{4}\}/,
    )?.[1];

    expect(selectedRow).toContain('var(--project-picker-row-accent) 7%');
    expect(selectedRow).toContain('var(--project-picker-row-accent) 16%');
    expect(selectedRow).toContain('box-shadow: none');
    expect(selectedSuggestion).toContain('background: var(--crate-control-active-bg)');
    expect(selectedSuggestion).toContain('box-shadow: none');
    expect(modalStyles).toContain('width: min(560px, calc(100vw - 40px))');
  });

  it('contains project-list scrolling inside the foreground picker', async () => {
    const pickerStyles = await readFile(
      new URL('../../styles/plugin-ui/_reminder-editor.scss', import.meta.url),
      'utf8',
    );
    const pickerComponent = await readFile(
      new URL('./reminder-modal/ProjectPickerModal.tsx', import.meta.url),
      'utf8',
    );
    const editorComponent = await readFile(
      new URL('./reminder-modal/AddReminderModal.tsx', import.meta.url),
      'utf8',
    );

    const scrollBlock = pickerStyles.match(
      /\.project-picker-scroll \{([\s\S]*?)\n\}/,
    )?.[1];

    expect(scrollBlock).toContain('overscroll-behavior: none');
    expect(pickerComponent).toContain('onWheel={(event) => event.stopPropagation()}');
    expect(pickerComponent).toContain('onTouchMove={(event) => event.stopPropagation()}');
    expect(editorComponent).toContain("pointerEvents: 'none'");
  });

  it('scrolls autocomplete options without moving the editor ancestor', async () => {
    const sharedStyles = await readFile(
      new URL('./shared/styles/_shell.scss', import.meta.url),
      'utf8',
    );
    const autocompleteComponent = await readFile(
      new URL('./reminder-modal/ProjectAutocompleteDropdown.tsx', import.meta.url),
      'utf8',
    );

    const dropdownBlock = sharedStyles.match(
      /\.project-autocomplete-dropdown \{([\s\S]*?)\n\}/,
    )?.[1];

    expect(dropdownBlock).toContain('overscroll-behavior: none');
    expect(autocompleteComponent).not.toContain('.scrollIntoView(');
    expect(autocompleteComponent).toContain('scrollContainer.scrollTop +=');
    expect(autocompleteComponent).toContain('onWheel={(event) => event.stopPropagation()}');
    expect(autocompleteComponent).toContain('onTouchMove={(event) => event.stopPropagation()}');
    expect(autocompleteComponent).toContain("closest<HTMLElement>('.base-modal-surface')");
    expect(autocompleteComponent).toContain('availableBelow < desiredHeight');
    expect(autocompleteComponent).toContain('style={{ left, width, maxHeight, ...verticalPosition }}');
  });
});
