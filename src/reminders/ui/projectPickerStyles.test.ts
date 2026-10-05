import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('project picker styles', () => {
  it('uses compact theme-aware selection without an accent rail', async () => {
    const pickerStyles = await readFile(
      new URL('./shared/styles/_pickers.scss', import.meta.url),
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

    expect(selectedRow).toContain('background: var(--picker-selected-bg)');
    expect(pickerStyles).not.toContain('--project-picker-row-accent');
    expect(selectedRow).toContain('box-shadow: none');
    expect(selectedSuggestion).toContain('background: var(--crate-control-active-bg)');
    expect(selectedSuggestion).toContain('box-shadow: none');
    expect(modalStyles).toContain('width: min(380px, calc(100vw - 40px))');
  });
});
