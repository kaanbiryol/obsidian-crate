import React from 'react';
import { Button } from '@/ui/shared/Button';

export function PwaScheduleSwitcher({ value, onChange, inert = false }: {
	value: 'today' | 'upcoming';
	onChange: (value: 'today' | 'upcoming') => void;
	inert?: boolean;
}) {
	return <div className="pwa-schedule-switcher" data-value={value} role="group" aria-label="Reminder dates" inert={inert}>
		<div className="pwa-schedule-control">
			{(['today', 'upcoming'] as const).map(view => (
				<Button key={view} className="pwa-schedule-chip" aria-pressed={value === view} onClick={() => onChange(view)}>
					{view === 'today' ? 'Today' : 'Upcoming'}
				</Button>
			))}
		</div>
	</div>;
}
