import { Notice, type TextComponent, type TextAreaComponent } from 'obsidian';

export function parseSettingInteger(value: string, minimum: number, maximum = Number.MAX_SAFE_INTEGER): number | null {
	if (!/^\d+$/.test(value.trim())) return null;
	const number = Number(value);
	return Number.isSafeInteger(number) && number >= minimum && number <= maximum ? number : null;
}

export function bindCommittedText(
	text: TextComponent | TextAreaComponent,
	currentValue: () => string,
	save: (value: string) => Promise<void>,
	validate: (value: string) => boolean = () => true,
): void {
	let saving = false;
	const commit = async () => {
		if (saving) return;
		const value = text.inputEl.value.trim();
		if (value === currentValue()) return;
		if (!validate(value)) {
			new Notice('Enter a valid value for this setting.');
			text.setValue(currentValue());
			return;
		}
		saving = true;
		text.setDisabled(true);
		try {
			await save(value);
		} catch {
			new Notice('Could not save this setting. Please try again.');
		} finally {
			text.setValue(currentValue());
			text.setDisabled(false);
			saving = false;
		}
	};
	text.inputEl.addEventListener('blur', () => { void commit(); });
	text.inputEl.addEventListener('keydown', (event: KeyboardEvent) => {
		if (event.key === 'Enter' && text.inputEl.tagName === 'INPUT') {
			event.preventDefault();
			text.inputEl.blur();
		}
	});
}

export function configureIntegerInput(text: TextComponent, minimum: number, maximum = Number.MAX_SAFE_INTEGER): void {
	text.inputEl.type = 'number';
	text.inputEl.min = String(minimum);
	text.inputEl.max = String(maximum);
	text.inputEl.step = '1';
	text.inputEl.required = true;
}
