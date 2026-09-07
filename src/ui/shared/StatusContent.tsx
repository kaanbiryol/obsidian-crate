import { useEffect, useState } from 'react';
import { ThemeIcon } from '../../reminders/components/theme-icon';

export interface StatusContentProps {
    state: 'working' | 'success' | 'error';
    description: string;
    details?: string[];
    technicalDetails?: string;
}

function WorkingDuration() {
    const [started] = useState(() => Date.now());
    const [seconds, setSeconds] = useState(0);
    useEffect(() => {
        const timer = window.setInterval(() => setSeconds(Math.floor((Date.now() - started) / 1000)), 1000);
        return () => window.clearInterval(timer);
    }, [started]);
    const duration = seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
    return <p className="crate-status-guidance">Elapsed: {duration} · Keep Obsidian open.</p>;
}

export function StatusContent({ state, description, details, technicalDetails }: StatusContentProps) {
    return <>
        <div className="crate-status-content" role="status" aria-live="polite" aria-busy={state === 'working'}>
            <span className={`crate-status-icon is-${state}`} aria-hidden="true">
                <ThemeIcon size="m" id={state === 'working' ? 'loader-circle' : state === 'success' ? 'circle-check' : 'triangle-alert'} />
            </span>
            <p>{description}</p>
        </div>
        {state === 'working' && <WorkingDuration />}
        {details?.map((detail, index) => <p className="crate-status-guidance" key={index}>{detail}</p>)}
        {technicalDetails && <details className="crate-status-details">
            <summary>Technical details</summary>
            <p>{technicalDetails}</p>
        </details>}
    </>;
}
