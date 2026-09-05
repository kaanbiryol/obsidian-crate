import { useEffect, useState } from 'react';

import { parseLocalDateKey } from '../../utils/reminderDate';
import { PickerNativeControl } from './PickerNativeControl';

interface EditableDateControlProps {
	commitOnChange?: boolean;
	label: string;
	emptyLabel: string;
	invalidMessage: string;
	value: string;
	onChange: (value: string) => void;
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

export function EditableDateControl({ commitOnChange = false, label, emptyLabel, invalidMessage, value, onChange }: EditableDateControlProps) {
	const [draft, setDraft] = useState(value);
	const [invalid, setInvalid] = useState(false);

	useEffect(() => {
		setDraft(value);
		setInvalid(false);
	}, [value]);

	return (
		<PickerNativeControl icon="calendar" hasValue={Boolean(value)} emptyLabel={emptyLabel} invalid={invalid}>
			{value && <span className="picker-date-display" aria-hidden="true">{formatDisplayDate(value)}</span>}
			<input
				type="date"
				min="0001-01-01"
				max="9999-12-31"
				autoComplete="off"
				aria-label={label}
				aria-invalid={invalid || undefined}
				title={invalid ? invalidMessage : undefined}
				value={draft}
				onChange={(event) => {
					const input = event.currentTarget;
					setInvalid(!input.validity.valid);
					if (input.validity.valid) {
						setDraft(input.value);
						if (commitOnChange) onChange(input.value);
					}
				}}
				onBlur={(event) => {
					const input = event.currentTarget;
					if (input.validity.valid) {
						if (!commitOnChange) onChange(input.value);
					} else {
						input.value = value;
						setDraft(value);
					}
				}}
				onKeyDown={(event) => {
					if (event.key === 'Enter') event.currentTarget.blur();
					if (event.key === 'Escape') {
						event.currentTarget.value = value;
						setDraft(value);
						setInvalid(false);
						event.currentTarget.blur();
					}
				}}
				className="picker-date-input"
			/>
		</PickerNativeControl>
	);
}
