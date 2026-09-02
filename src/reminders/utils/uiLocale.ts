export function getUiLocale(): string | undefined {
	if (typeof document !== 'undefined') {
		const documentLocale = document.documentElement?.lang?.trim();
		if (documentLocale) return documentLocale;
	}

	if (typeof navigator !== 'undefined' && navigator.language) {
		return navigator.language;
	}

	return undefined;
}

export function sentenceCaseLocalized(value: string, locale = getUiLocale()): string {
	const [first = '', ...rest] = Array.from(value);
	return `${first.toLocaleUpperCase(locale)}${rest.join('')}`;
}
