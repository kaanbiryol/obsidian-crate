import { ModalHeader } from '../../../ui/shared/ModalHeader';
import { Button } from '../../../ui/shared/Button';
import { DateQuickButtons } from './DateQuickButtons';
import { EditableDateControl } from './EditableDateControl';
import { PickerTimeCard } from './PickerTimeCard';
import { PickerContent } from './PickerContent';
import { PickerFieldRow } from './PickerFieldRow';
import { PickerSection } from './PickerSection';
import { formatLocalDateKey } from '../../utils/reminderDate';
import type { ReminderDatePreset } from './datePresets';
import { REMINDER_PICKER_COPY } from './pickerCopy';

interface DatePickerContentProps {
    currentDate: Date | null;
    hasTime: boolean;
    isDark: boolean;
    idPrefix?: string;
    commitDateOnChange?: boolean;
    onClose: () => void;
    onSelectPreset: (preset: ReminderDatePreset) => void;
    onDateChange: (value: string) => void;
    onTimeChange: (hour: number, minute: number) => void;
    onTimeClear: () => void;
    onRemove: () => void;
}

export function DatePickerContent({
    currentDate, hasTime, isDark, idPrefix = 'plugin', commitDateOnChange = false,
    onClose, onSelectPreset, onDateChange, onTimeChange, onTimeClear, onRemove,
}: DatePickerContentProps) {
    return (
        <div className={`reminder-picker reminder-date-picker${isDark ? ' dark' : ''}`}>
            <ModalHeader
                onClose={onClose}
                closeLabel={REMINDER_PICKER_COPY.schedule.closeLabel}
                title={REMINDER_PICKER_COPY.schedule.title}
                action={{
                    label: REMINDER_PICKER_COPY.schedule.done,
                    disabled: !currentDate,
                    onClick: onClose,
                }}
            />

            <div className="reminder-picker-scroll">
                <PickerContent>
                    <PickerSection
                        headingId={`${idPrefix}-quick-schedule-title`}
                        title={REMINDER_PICKER_COPY.schedule.quickOptions}
                    >
                        <DateQuickButtons
                            currentDate={currentDate}
                            hasTime={hasTime ?? false}
                            onSelectPreset={onSelectPreset}
                        />
                    </PickerSection>

                    <PickerSection
                        headingId={`${idPrefix}-custom-schedule-title`}
                        title={REMINDER_PICKER_COPY.schedule.custom}
                        className="picker-custom-schedule"
                        action={currentDate ? (
                            <Button
                                className="picker-schedule-remove"
                                onClick={onRemove}
                            >
                                {REMINDER_PICKER_COPY.schedule.remove}
                            </Button>
                        ) : undefined}
                    >
                        <div className="picker-schedule-fields">
                            <PickerFieldRow
                                label={REMINDER_PICKER_COPY.schedule.date}
                                className="picker-date-field"
                                asLabel
                            >
                                <EditableDateControl
                                    commitOnChange={commitDateOnChange}
                                    label={REMINDER_PICKER_COPY.schedule.date}
                                    emptyLabel={REMINDER_PICKER_COPY.schedule.addDate}
                                    invalidMessage={REMINDER_PICKER_COPY.schedule.invalidDate}
                                    value={currentDate ? formatLocalDateKey(currentDate) : ''}
                                    onChange={onDateChange}
                                />
                            </PickerFieldRow>
                            <PickerTimeCard
                                label={REMINDER_PICKER_COPY.schedule.time}
                                detail={REMINDER_PICKER_COPY.schedule.optional}
                                controlIcon="clock"
                                controlEmptyLabel={REMINDER_PICKER_COPY.schedule.addTime}
                                hour={currentDate && hasTime ? currentDate.getHours() : undefined}
                                minute={currentDate && hasTime ? currentDate.getMinutes() : undefined}
                                onChange={onTimeChange}
                                onClear={onTimeClear}
                            />
                        </div>
                    </PickerSection>
                </PickerContent>
            </div>
        </div>
    );
}
