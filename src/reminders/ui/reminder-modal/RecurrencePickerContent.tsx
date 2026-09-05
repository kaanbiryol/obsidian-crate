import { ModalHeader } from '../../../ui/shared/ModalHeader';
import { Button } from '../../../ui/shared/Button';
import { PickerTimeCard } from './PickerTimeCard';
import { PickerContent } from './PickerContent';
import { PickerCurrentSummary } from './PickerCurrentSummary';
import { RecurrenceFrequencyOptions } from './RecurrenceFrequencyOptions';
import { RecurrenceFrequencyTabs } from './RecurrenceFrequencyTabs';
import { summarizeRecurrencePickerState, type RecurrencePickerState } from './recurrencePickerShared';
import { REMINDER_PICKER_COPY } from './pickerCopy';

interface RecurrencePickerContentProps {
    state: RecurrencePickerState;
    onChange: (patch: Partial<RecurrencePickerState>) => void;
    isDark: boolean;
    animationsEnabled: boolean;
    canRemove: boolean;
    onClose: () => void;
    onDone: () => void;
    onRemove: () => void;
}

export function RecurrencePickerContent({ state, onChange, isDark, animationsEnabled, canRemove, onClose, onDone, onRemove }: RecurrencePickerContentProps) {
    const { frequency, interval, daysOfWeek: selectedDays, dayOfMonth, hour, minute } = state;
    const summaryText = summarizeRecurrencePickerState(state);
    return (
        <div className={`reminder-picker reminder-recurrence-picker${isDark ? ' dark' : ''}`}>
            <ModalHeader
                onClose={onClose}
                closeLabel={REMINDER_PICKER_COPY.repeat.closeLabel}
                title={REMINDER_PICKER_COPY.repeat.title}
                action={{
                    label: REMINDER_PICKER_COPY.repeat.done,
                    onClick: onDone,
                }}
            />

            <div className="reminder-picker-scroll">
                <PickerContent>
                    <RecurrenceFrequencyTabs
                        frequency={frequency}
                        onChange={(frequency) => onChange({ frequency })}
                    />

                    <RecurrenceFrequencyOptions
                        frequency={frequency}
                        animationsEnabled={animationsEnabled}
                        interval={interval}
                        selectedDays={selectedDays}
                        dayOfMonth={dayOfMonth}
                        timeControl={
                            <PickerTimeCard
                                label={REMINDER_PICKER_COPY.repeat.reminderTime}
                                controlIcon="clock"
                                hour={hour}
                                minute={minute}
                                onChange={(hour, minute) => onChange({ hour, minute })}
                            />
                        }
                        onIntervalChange={(interval) => onChange({ interval })}
                        onToggleDay={(day) => onChange({ daysOfWeek: selectedDays.includes(day) ? selectedDays.filter(value => value !== day) : [...selectedDays, day].sort((a, b) => a - b) })}
                        onDayOfMonthChange={(dayOfMonth) => onChange({ dayOfMonth })}
                    />

                    <div className="recurrence-summary-row">
                        <PickerCurrentSummary
                            label={REMINDER_PICKER_COPY.repeat.current}
                            value={summaryText}
                            icon="repeat"
                        />
                        {canRemove && (
                            <Button
                                className="picker-repeat-remove"
                                onClick={onRemove}
                            >
                                {REMINDER_PICKER_COPY.repeat.remove}
                            </Button>
                        )}
                    </div>
                </PickerContent>
            </div>
        </div>
    );
}
