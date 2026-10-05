const descriptionErrors = {
	'invalid-description-block': 'Invalid reminder description block',
	'invalid-description-encoding': 'Invalid reminder description encoding',
	'unsupported-description-encoding': 'Unsupported reminder description encoding',
} as const;

export class ReminderDescriptionError extends Error {
	constructor(readonly code: keyof typeof descriptionErrors, readonly line?: number, options?: ErrorOptions) {
		super(`${descriptionErrors[code]}${line === undefined ? '' : ` on line ${line}`}`, options);
		this.name = 'ReminderDescriptionError';
	}
}

const DESCRIPTION_ENCODING_PREFIX = "v1:";

export function encodeDescriptionForMarkdown(description: string): string {
	const text = description.trim();
	// Keep note text readable. Escape only HTML comment syntax, literal carriage
	// returns and prefixes that the existing reader interprets as an encoding.
	if (!/--|\r|^v\d+:/.test(text)) return text;
	return `${DESCRIPTION_ENCODING_PREFIX}${encodeURIComponent(text).replace(/-/g, "%2D")}`;
}

export function decodeDescriptionFromMarkdown(description: string): string {
	const trimmed = description.trim();
	if (!trimmed.startsWith(DESCRIPTION_ENCODING_PREFIX)) {
		if (/^v\d+:/.test(trimmed)) throw new ReminderDescriptionError('unsupported-description-encoding');
		// Unversioned descriptions are literal text, including percent signs.
		return trimmed;
	}
	try { return decodeURIComponent(trimmed.slice(DESCRIPTION_ENCODING_PREFIX.length)); }
	catch (error) {
		if (error instanceof URIError) throw new ReminderDescriptionError('invalid-description-encoding', undefined, { cause: error });
		throw error;
	}
}

export function buildDescriptionBlock(description: string | undefined): string[] {
	if (!description?.trim()) return [];
	return `<!-- crate-desc:${encodeDescriptionForMarkdown(description)} -->`.split('\n');
}

export function readDescriptionBlock(
	lines: readonly string[],
	checkboxLineNumber: number,
): { description?: string; lineCount: number } {
	const nextIndex = checkboxLineNumber + 1;
	const nextLine = lines[nextIndex];
	const prefix = '<!-- crate-desc:';
	if (!nextLine?.startsWith(prefix)) return { lineCount: 0 };

	const payload = nextLine.slice(prefix.length);
	const versioned = /^v\d+:/.test(payload.trimStart());
	const descriptionLines: string[] = [];
	for (let index = nextIndex; index < lines.length; index++) {
		const line = (index === nextIndex ? payload : lines[index]!).replace(/\r$/, '');
		if (line.includes('<!--')) throw new ReminderDescriptionError('invalid-description-block', nextIndex + 1);
		const end = line.indexOf('-->');
		if (end !== -1) {
			if (!line.endsWith(' -->') || end !== line.length - 3) throw new ReminderDescriptionError('invalid-description-block', nextIndex + 1);
			descriptionLines.push(line.slice(0, end));
			try {
				return {
					description: decodeDescriptionFromMarkdown(descriptionLines.join('\n')) || undefined,
					lineCount: index - nextIndex + 1,
				};
			} catch (error) {
				if (error instanceof ReminderDescriptionError) throw new ReminderDescriptionError(error.code, nextIndex + 1, { cause: error });
				const reason = error instanceof Error ? error.message : 'Invalid reminder description block';
				throw new Error(`${reason} on line ${nextIndex + 1}`, { cause: error });
			}
		}
		// Encoded descriptions are always one line; plain text may span lines.
		if (versioned) throw new ReminderDescriptionError('invalid-description-block', nextIndex + 1);
		descriptionLines.push(line);
	}
	throw new ReminderDescriptionError('invalid-description-block', nextIndex + 1);
}
