import { useEffect, useState } from 'react';

import { formatLocalDateKey, parseLocalDateKey } from '../../utils/reminderDate';
import { PickerNativeControl } from './PickerNativeControl';

interface EditableDateControlProps {
	label: string;
	emptyLabel: string;
	invalidMessage: string;
	value: string;
	onChange: (value: string) => void;
}

function getDateFormatter(locale?: string): Intl.DateTimeFormat {
	return new Intl.DateTimeFormat(locale, {
		calendar: 'gregory',
		numberingSystem: 'latn',
		day: '2-digit',
		month: '2-digit',
		year: 'numeric',
	});
}

function getDatePartOrder(locale?: string): Array<'day' | 'month' | 'year'> {
	return getDateFormatter(locale)
		.formatToParts(new Date(2006, 10, 22))
		.map(part => part.type)
		.filter((part): part is 'day' | 'month' | 'year' => (
			part === 'day' || part === 'month' || part === 'year'
		));
}

function toValidDateKey(year: number, month: number, day: number): string | null {
	const date = new Date(year, month - 1, day);
	if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
		return null;
	}
	return formatLocalDateKey(date);
}

export function formatEditableDate(value: string, locale?: string): string {
	if (!value) return '';
	return getDateFormatter(locale).format(parseLocalDateKey(value));
}

export function formatDisplayDate(value: string, locale?: string): string {
	if (!value) return '';
	return new Intl.DateTimeFormat(locale, {
		calendar: 'gregory',
		numberingSystem: 'latn',
		day: 'numeric',
		month: 'short',
		year: 'numeric',
	}).format(parseLocalDateKey(value));
}

export function parseEditableDate(value: string, locale?: string): string | null {
	const trimmed = value.trim();
	if (!trimmed) return '';

	const isoMatch = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(trimmed);
	if (isoMatch) {
		return toValidDateKey(Number(isoMatch[1]), Number(isoMatch[2]), Number(isoMatch[3]));
	}

	const values = trimmed.match(/\d+/g)?.map(Number);
	const order = getDatePartOrder(locale);
	if (!values || values.length !== 3 || order.length !== 3) return null;

	const parts: Partial<Record<'day' | 'month' | 'year', number>> = {};
	order.forEach((part, index) => {
		parts[part] = values[index];
	});
	if (parts.year === undefined || parts.month === undefined || parts.day === undefined) return null;
	return toValidDateKey(parts.year, parts.month, parts.day);
}

export function getEditableDatePlaceholder(locale?: string): string {
	const labels = { day: 'DD', month: 'MM', year: 'YYYY' } as const;
	return getDateFormatter(locale)
		.formatToParts(new Date(2006, 10, 22))
		.map(part => (
			part.type === 'day' || part.type === 'month' || part.type === 'year'
				? labels[part.type]
				: part.value
		))
		.join('');
}

export function EditableDateControl({ label, emptyLabel, invalidMessage, value, onChange }: EditableDateControlProps) {
	const displayValue = formatDisplayDate(value);
	const [draft, setDraft] = useState(displayValue);
	const [invalid, setInvalid] = useState(false);

	useEffect(() => {
		setDraft(displayValue);
		setInvalid(false);
	}, [displayValue]);

	const commit = (nextDraft: string) => {
		const nextValue = parseEditableDate(nextDraft);
		if (nextValue === null) {
			setInvalid(true);
			return;
		}
		setInvalid(false);
		setDraft(formatDisplayDate(nextValue));
		onChange(nextValue);
	};

	return (
		<PickerNativeControl
			icon="calendar"
			hasValue={Boolean(value)}
			emptyLabel={emptyLabel}
			invalid={invalid}
		>
			<span className="picker-date-input-sizer" aria-hidden="true">
				{draft || getEditableDatePlaceholder()}
			</span>
			<input
				type="text"
				inputMode="numeric"
				autoComplete="off"
				spellCheck={false}
				aria-label={label}
				aria-invalid={invalid || undefined}
				title={invalid ? invalidMessage : undefined}
				placeholder={getEditableDatePlaceholder()}
				value={draft}
				onFocus={() => {
					if (!invalid) setDraft(formatEditableDate(value));
				}}
				onChange={(event) => {
					setInvalid(false);
					setDraft(event.currentTarget.value);
				}}
				onBlur={(event) => commit(event.currentTarget.value)}
				onKeyDown={(event) => {
					if (event.key === 'Enter') event.currentTarget.blur();
					if (event.key === 'Escape') {
						event.currentTarget.value = displayValue;
						setInvalid(false);
						setDraft(displayValue);
						event.currentTarget.blur();
					}
				}}
				className="picker-date-input"
			/>
			<input
				type="date"
				data-picker-proxy
				tabIndex={-1}
				aria-hidden="true"
				value={value}
				onChange={(event) => onChange(event.currentTarget.value)}
				className="picker-native-picker-proxy"
			/>
		</PickerNativeControl>
	);
}
