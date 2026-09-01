interface WeekInfo {
	firstDay: number;
}

interface LocaleWithWeekInfo {
	weekInfo?: WeekInfo;
	getWeekInfo?: () => WeekInfo;
}

interface IntlWithLocale {
	Locale?: new (tag: string) => LocaleWithWeekInfo;
}

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

/** Returns a JavaScript weekday index (Sunday = 0) for the locale's first day. */
export function getLocaleWeekStart(locale = getUiLocale()): number {
	if (!locale) return 0;

	try {
		const Locale = (Intl as unknown as IntlWithLocale).Locale;
		if (!Locale) return 0;
		const localeInfo = new Locale(locale);
		const weekInfo = localeInfo.getWeekInfo?.() ?? localeInfo.weekInfo;
		return weekInfo ? weekInfo.firstDay % 7 : 0;
	} catch {
		return 0;
	}
}

export function sentenceCaseLocalized(value: string, locale = getUiLocale()): string {
	const [first = '', ...rest] = Array.from(value);
	return `${first.toLocaleUpperCase(locale)}${rest.join('')}`;
}
