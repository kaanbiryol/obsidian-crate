import { useCallback, useRef, useState } from 'react';
import type { Reminder } from '../../types/reminder';

/** Keep live card data while a drag or its disk write owns the visible order. */
export function reconcileReminderOrder(reminders: Reminder[], ids: string[]): Reminder[] {
  const remaining = new Map(reminders.map((reminder) => [reminder.id, reminder]));
  const ordered: Reminder[] = [];
  for (const id of ids) {
    const reminder = remaining.get(id);
    if (reminder) ordered.push(reminder);
    remaining.delete(id);
  }
  return [...ordered, ...remaining.values()];
}

export function useReminderOrder(
  reminders: Reminder[],
  commit?: (ids: string[]) => Promise<void> | void,
  onDragActiveChange?: (active: boolean) => void,
) {
  const [order, setOrder] = useState<string[] | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const revision = useRef(0);
  const dragging = useRef(false);
  const pending = useRef(false);

  const onReorder = useCallback((next: Reminder[]) => {
    setOrder(next.map((reminder) => reminder.id));
  }, []);

  const onDragChange = useCallback((active: boolean) => {
    setIsDragging(active);
    dragging.current = active;
    if (!active && !pending.current) setOrder(null);
    onDragActiveChange?.(active);
  }, [onDragActiveChange]);

  const onCommit = useCallback((ids: string[]) => {
    const currentRevision = ++revision.current;
    pending.current = true;
    setOrder(ids);
    // Persistence adapters report failures and refresh authoritative data.
    void (async () => {
      try {
        await commit?.(ids);
      } finally {
        if (revision.current === currentRevision) {
          pending.current = false;
          if (!dragging.current) setOrder(null);
        }
      }
    })();
  }, [commit]);

  return {
    displayedOrder: order ? reconcileReminderOrder(reminders, order) : reminders,
    isDragging,
    onReorder,
    onCommit,
    onDragChange,
  };
}
