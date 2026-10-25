import { expect, it } from 'vitest';
import { DEVELOPMENT_SHORTCUT_FILE_PATH, DEVELOPMENT_SHORTCUT_PATH } from '@/reading/shortcut';
import { requestAdmissionKind } from '../routes/admission';
import { developmentShortcutPage, developmentShortcutResponse } from './development-shortcut';

it('offers an embedded development shortcut from a page link', async () => {
  const page = developmentShortcutPage(btoa('AEA1signed'))!;
  expect(page.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
  expect(await page.text()).toContain(`href="${DEVELOPMENT_SHORTCUT_FILE_PATH}"`);
  const response = developmentShortcutResponse(btoa('AEA1signed'))!;
  expect(new TextDecoder().decode(await response.arrayBuffer())).toBe('AEA1signed');
  expect(response.headers.get('Cache-Control')).toBe('no-store');
});
it('keeps the development download absent from release Workers', () => {
  expect(developmentShortcutPage()).toBeNull();
  expect(developmentShortcutResponse()).toBeNull();
  for (const path of [DEVELOPMENT_SHORTCUT_PATH, DEVELOPMENT_SHORTCUT_FILE_PATH]) {
    expect(requestAdmissionKind(new Request(`https://crate.example${path}`))).toBe('unknown');
  }
});
