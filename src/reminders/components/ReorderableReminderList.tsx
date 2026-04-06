import React, { useCallback, useRef } from 'react';
import { Reorder } from 'framer-motion';
import type { Reminder } from '../types/reminder';

interface ReorderableReminderListProps {
  reminders: Reminder[];
  onReorder: (reordered: Reminder[]) => void;
  onReorderCommit: (orderedIds: string[]) => void;
  onDragActiveChange?: (active: boolean) => void;
  renderCard: (reminder: Reminder, index: number) => React.ReactNode;
}

interface ReorderableItemProps {
  reminder: Reminder;
  index: number;
  renderCard: (reminder: Reminder, index: number) => React.ReactNode;
  onDragStart: () => void;
  onDragEnd: () => void;
}

function ReorderableItem({ reminder, index, renderCard, onDragStart, onDragEnd }: ReorderableItemProps) {
  const didDragRef = useRef(false);

  const handleDragStart = useCallback(() => {
    didDragRef.current = true;
    onDragStart();
  }, [onDragStart]);

  const handleDragEnd = useCallback(() => {
    onDragEnd();
    // Suppress the click event that fires after drag release
    // Use requestAnimationFrame so the flag clears after the click event
    requestAnimationFrame(() => {
      didDragRef.current = false;
    });
  }, [onDragEnd]);

  const handleClickCapture = useCallback((e: React.MouseEvent) => {
    if (didDragRef.current) {
      e.stopPropagation();
      e.preventDefault();
    }
  }, []);

  return (
    <Reorder.Item
      as="div"
      value={reminder}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onClickCapture={handleClickCapture}
      style={{ marginBottom: '0.5rem', cursor: 'grab' }}
      whileTap={{
        scale: 1.03,
        boxShadow: '0 4px 16px rgba(0, 0, 0, 0.25)',
      }}
      whileDrag={{
        scale: 1.05,
        boxShadow: '0 12px 32px rgba(0, 0, 0, 0.35)',
        zIndex: 50,
        cursor: 'grabbing',
      }}
      transition={{
        layout: { type: 'spring', stiffness: 350, damping: 35 },
      }}
    >
      {renderCard(reminder, index)}
    </Reorder.Item>
  );
}

export function ReorderableReminderList({
  reminders,
  onReorder,
  onReorderCommit,
  onDragActiveChange,
  renderCard,
}: ReorderableReminderListProps) {
  const latestOrderRef = useRef(reminders);
  latestOrderRef.current = reminders;
  const orderBeforeDragRef = useRef<string[]>([]);

  const handleDragStart = useCallback(() => {
    orderBeforeDragRef.current = latestOrderRef.current.map(r => r.id);
    onDragActiveChange?.(true);
  }, [onDragActiveChange]);

  const handleDragEnd = useCallback(() => {
    const newOrder = latestOrderRef.current.map(r => r.id);
    const changed = newOrder.length !== orderBeforeDragRef.current.length
      || newOrder.some((id, i) => id !== orderBeforeDragRef.current[i]);
    if (changed) {
      onReorderCommit(newOrder);
    }
    onDragActiveChange?.(false);
  }, [onReorderCommit, onDragActiveChange]);

  return (
    <Reorder.Group
      as="div"
      axis="y"
      values={reminders}
      onReorder={onReorder}
    >
      {reminders.map((reminder, index) => (
        <ReorderableItem
          key={reminder.id}
          reminder={reminder}
          index={index}
          renderCard={renderCard}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
        />
      ))}
    </Reorder.Group>
  );
}
