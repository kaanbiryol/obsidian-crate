import { ThemeIcon } from '../../components/theme-icon';

interface PickerCurrentSummaryProps {
    label: string;
    value: string;
    icon: string;
}

export function PickerCurrentSummary({
    label,
    value,
    icon,
}: PickerCurrentSummaryProps) {
    return (
        <div className="picker-current-summary" aria-live="polite">
            <span className="picker-current-label">{label}</span>
            <span className="picker-current-value">
                <ThemeIcon size="s" id={icon} aria-hidden="true" />
                <strong>{value}</strong>
            </span>
        </div>
    );
}
