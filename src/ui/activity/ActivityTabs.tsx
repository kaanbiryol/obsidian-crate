import { useLayoutEffect, useRef, useState } from 'react';
import { Tabs } from '@base-ui/react/tabs';

interface ActivityTabElements {
    pending: HTMLDivElement;
    conflicts: HTMLDivElement;
    history: HTMLDivElement;
    pendingCount: HTMLSpanElement;
    conflictsCount: HTMLSpanElement;
}

interface Props {
    initialTab: 'pending' | 'conflicts' | 'history';
    onMount: (elements: ActivityTabElements) => void;
    onTabChange: (index: number) => void;
}

/** React owns tab semantics; Obsidian's incremental renderers own each panel's contents. */
export function ActivityTabs({ initialTab, onMount, onTabChange }: Props) {
    const [active, setActive] = useState(initialTab);
    const pending = useRef<HTMLDivElement>(null);
    const conflicts = useRef<HTMLDivElement>(null);
    const history = useRef<HTMLDivElement>(null);
    const pendingCount = useRef<HTMLSpanElement>(null);
    const conflictsCount = useRef<HTMLSpanElement>(null);
    useLayoutEffect(() => {
        if (!pending.current || !conflicts.current || !history.current || !pendingCount.current || !conflictsCount.current) return;
        onMount({ pending: pending.current, conflicts: conflicts.current, history: history.current,
            pendingCount: pendingCount.current, conflictsCount: conflictsCount.current });
    }, [onMount]);
    return <Tabs.Root value={active} onValueChange={value => {
        const tab = value as typeof active;
        setActive(tab);
        onTabChange(tab === 'pending' ? 0 : tab === 'conflicts' ? 1 : 2);
    }} className="crate-activity-tabs-layout">
        <div className="crate-activity-tab-bar">
            <Tabs.List className="crate-activity-tabs" aria-label="Sync activity" activateOnFocus>
                {(['pending', 'conflicts', 'history'] as const).map((tab, index) => <Tabs.Tab
                    key={tab} value={tab}
                    className={`crate-activity-tab${active === tab ? ' crate-activity-tab-active' : ''}`}
                ><span>{['Pending', 'Conflicts', 'History'][index]}</span>
                    {tab === 'pending' && <span ref={pendingCount} className="crate-tab-count" />}
                    {tab === 'conflicts' && <span ref={conflictsCount} className="crate-tab-count" />}
                </Tabs.Tab>)}
                <Tabs.Indicator className="crate-activity-tab-indicator" />
            </Tabs.List>
        </div>
        <Tabs.Panel keepMounted value="pending" ref={pending} className="crate-activity-panel crate-activity-panel-pending" />
        <Tabs.Panel keepMounted value="conflicts" ref={conflicts} className="crate-activity-panel crate-activity-panel-conflicts" />
        <Tabs.Panel keepMounted value="history" ref={history} className="crate-activity-panel" />
    </Tabs.Root>;
}
