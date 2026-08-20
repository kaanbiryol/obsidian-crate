import React from 'react';
import { Clock } from 'lucide-react';
import { TimeInput } from '@heroui/react';
import { Time } from '@internationalized/date';

interface PickerTimeCardProps {
    hour: number;
    minute: number;
    onChange: (hour: number, minute: number) => void;
}

export const PickerTimeCard: React.FC<PickerTimeCardProps> = ({
    hour,
    minute,
    onChange,
}) => {
    return (
        <div className="picker-time-card">
            <div className="flex items-center gap-3">
                <Clock
                    size={16}
                    strokeWidth={1.75}
                    className="picker-time-icon"
                />
                <span className="picker-time-label">
                    Time
                </span>
                <div className="ml-auto">
                    <TimeInput
                        aria-label="Time"
                        size="sm"
                        granularity="minute"
                        hourCycle={24}
                        value={new Time(hour, minute)}
                        onChange={(time) => {
                            if (time) {
                                onChange(time.hour, time.minute);
                            }
                        }}
                        classNames={{
                            base: 'w-auto',
                            inputWrapper: [
                                'shadow-none',
                                'h-9 min-h-9 px-3 rounded-xl',
                                'bg-[var(--crate-glass-surface-bg)]',
                                'border border-[var(--crate-glass-surface-border)]',
                            ].join(' '),
                            input: 'text-[14px] font-semibold text-[var(--text-normal)]',
                            segment: 'text-[14px] font-semibold data-[placeholder=true]:text-[var(--text-muted)]',
                        }}
                    />
                </div>
            </div>
        </div>
    );
};
