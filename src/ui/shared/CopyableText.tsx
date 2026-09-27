import { useEffect, useId, useRef, useState } from 'react';
import { Button } from './Button';

interface CopyableTextProps {
	value: string;
	label: string;
	copyLabel: string;
	successMessage: string;
	failureMessage: string;
	description?: string;
	alwaysShow?: boolean;
	fieldClassName?: string;
	buttonClassName?: string;
	/** Runs synchronously in the click; false cancels, throws report copy failure. */
	beforeCopy?: () => boolean | void;
}

export function CopyableText({ value, label, copyLabel, successMessage, failureMessage,
	description, alwaysShow = false, fieldClassName, buttonClassName, beforeCopy }: CopyableTextProps) {
	const id = useId();
	const generation = useRef<symbol | null>(null);
	const [result, setResult] = useState<{ value: string; copied: boolean } | null>(null);
	useEffect(() => {
		// Late clipboard completions must not announce a replaced value or unmounted field.
		generation.current = null;
		setResult(null);
		return () => { generation.current = null; };
	}, [value]);
	const current = result?.value === value ? result : null;
	const showField = alwaysShow || current?.copied === false;
	const field = showField && <>
		<label className={alwaysShow ? 'crate-field__label' : 'crate-field__label--hidden'} htmlFor={id}>{label}</label>
		<textarea id={id} className={['crate-text-input', fieldClassName].filter(Boolean).join(' ')}
			readOnly rows={3} value={value} autoCapitalize="none" autoComplete="off" spellCheck={false}
			aria-describedby={`${id}-status`} onFocus={event => event.currentTarget.select()} />
	</>;
	const copy = async (ownerDocument: Document) => {
		const request = Symbol();
		generation.current = request;
		try {
			if (beforeCopy?.() === false) return;
			// Use the control's window for Obsidian popouts as well as the PWA.
			const clipboard = ownerDocument.defaultView?.navigator.clipboard;
			if (!clipboard) throw new Error('Clipboard unavailable');
			await clipboard.writeText(value);
			if (request === generation.current) setResult({ value, copied: true });
		} catch {
			if (request === generation.current) setResult({ value, copied: false });
		}
	};
	return <div className="crate-copyable-text">
		{alwaysShow && field}
		<Button variant="outline" className={buttonClassName} onClick={event => { void copy(event.currentTarget.ownerDocument); }}>{copyLabel}</Button>
		<span id={`${id}-status`} className={current?.copied === false ? 'crate-field__error' : 'crate-field__description'}
			role={current?.copied === false ? 'alert' : 'status'}>{current ? current.copied ? successMessage : failureMessage : description}</span>
		{!alwaysShow && field}
	</div>;
}
