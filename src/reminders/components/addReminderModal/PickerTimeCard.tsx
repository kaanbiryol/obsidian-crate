import React from 'react';
import { Clock } from 'lucide-react';
import { TimeInput } from '@heroui/react';
import { Time } from '@internationalized/date';

import { getGlassColors } from '../../ui/glassStyles';

interface PickerTimeCardProps {
    isDark: boolean;
    hour: number;
    minute: number;
    onChange: (hour: number, minute: number) => void;
}

export const PickerTimeCard: React.FC<PickerTimeCardProps> = ({
    isDark,
    hour,
    minute,
    onChange,
}) => {
    const glass = getGlassColors(isDark);

    return (
        <div
            style={{
                background: glass.surface.bg,
                border: `1px solid ${glass.surface.border}`,
                borderRadius: '12px',
                padding: '14px 16px',
            }}
        >
            <div className="flex items-center gap-3">
                <Clock
                    size={16}
                    strokeWidth={1.75}
                    style={{
                        color: 'var(--interactive-accent)',
                        filter: isDark ? 'drop-shadow(0 0 4px var(--interactive-accent))' : 'none',
                    }}
                />
                <span
                    style={{
                        fontSize: '14px',
                        fontWeight: 600,
                        color: 'var(--text-normal)',
                    }}
                >
                    Time
                </span>
                <div className={`ml-auto ${isDark ? 'dark text-foreground' : ''}`}>
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
                                `bg-[${isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.03)'}]`,
                                `border border-[${isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)'}]`,
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
