import React, { forwardRef, useId, type InputHTMLAttributes, type ReactNode } from 'react';

type TextFieldProps = InputHTMLAttributes<HTMLInputElement> & {
	label: string;
	hideLabel?: boolean;
	description?: string;
	error?: string;
	leadingIcon?: ReactNode;
	trailingAction?: ReactNode;
	fieldClassName?: string;
};

/** Plain native input with a linked label, help/error text, and optional adornments. */
export const TextField = forwardRef<HTMLInputElement, TextFieldProps>(function TextField({
	label, hideLabel, description, error, leadingIcon, trailingAction, fieldClassName,
	id, className, type = 'text', 'aria-describedby': describedBy, 'aria-invalid': invalid, ...props
}, ref) {
	const generatedId = useId();
	const inputId = id ?? generatedId;
	const descriptionId = `${inputId}-description`;
	const errorId = `${inputId}-error`;
	const descriptions = [describedBy, description && descriptionId, error && errorId].filter(Boolean).join(' ') || undefined;
	return <div className={['crate-field', type === 'search' && 'crate-field--search', trailingAction && 'crate-field--with-action', fieldClassName].filter(Boolean).join(' ')}>
		<label className={`crate-field__label${hideLabel ? ' crate-field__label--hidden' : ''}`} htmlFor={inputId}>{label}</label>
		<div className="crate-field__control">
			{leadingIcon && <span className="crate-field__icon" aria-hidden="true">{leadingIcon}</span>}
			<input {...props} ref={ref} id={inputId} type={type} className={['crate-text-input', className].filter(Boolean).join(' ')} aria-describedby={descriptions} aria-invalid={error ? true : invalid} />
			{trailingAction}
		</div>
		{description && <span className="crate-field__description" id={descriptionId}>{description}</span>}
		{error && <span className="crate-field__error" id={errorId} role="alert">{error}</span>}
	</div>;
});
