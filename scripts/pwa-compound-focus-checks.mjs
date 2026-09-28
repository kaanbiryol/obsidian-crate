import { expect } from '@playwright/test';

export async function checkCompoundFocus(page, control, wrapper) {
	const textEntry = await control.evaluate(element => element.tagName === 'INPUT' || element.tagName === 'TEXTAREA');
	const restingBorder = await wrapper.evaluate(element => getComputedStyle(element).borderColor);
	await control.tap();
	if (await control.evaluate(element => element.tagName === 'SELECT')) {
		await control.selectOption(await control.inputValue());
	}
	// Native focus can survive selection, sheet restoration, or text editing.
	await control.focus();
	await expect(control).toBeFocused();
	await expect(wrapper).toHaveCSS('outline-style', 'none');
	await expect(control).toHaveCSS('outline-style', 'none');
	await page.keyboard.press('Tab');
	await page.keyboard.press('Shift+Tab');
	await expect(control).toBeFocused();
	if (textEntry) {
		await expect(wrapper).toHaveCSS('outline-style', 'none');
		await expect(wrapper).not.toHaveCSS('border-color', restingBorder);
	} else {
		await expect(wrapper).toHaveCSS('outline-style', 'solid');
		await expect(wrapper).toHaveCSS('outline-width', '2px');
	}
	await expect(control).toHaveCSS('outline-style', 'none');
	// Switching back to the mouse must clear the wrapper ring immediately.
	await control.click();
	await expect(wrapper).toHaveCSS('outline-style', 'none');
	await expect(control).toHaveCSS('outline-style', 'none');
}

export async function checkSettingsFocus(page, sheet) {
	for (const wrapper of await sheet.locator('.settings-preference-control, .settings-tab-choice').all()) {
		await checkCompoundFocus(page, wrapper.locator('input, select'), wrapper);
	}
}
