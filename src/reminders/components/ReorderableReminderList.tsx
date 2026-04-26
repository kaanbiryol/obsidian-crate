import React, { useCallback, useRef } from 'react';
import { Reorder, useDragControls } from 'framer-motion';
import { GripVertical } from 'lucide-react';
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
  const dragControls = useDragControls();

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

  const handleDragHandlePointerDown = useCallback((e: React.PointerEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    dragControls.start(e);
  }, [dragControls]);

  return (
    <Reorder.Item
      as="div"
      value={reminder}
      className="reorderable-reminder-item"
      dragListener={false}
      dragControls={dragControls}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onClickCapture={handleClickCapture}
      style={{ marginBottom: '0.5rem' }}
      whileTap={{
        scale: 1,
      }}
      whileDrag={{
        scale: 1.02,
        zIndex: 50,
      }}
      transition={{
        layout: { type: 'spring', stiffness: 350, damping: 35 },
      }}
    >
      {renderCard(reminder, index)}
      <button
        className="reorder-drag-handle"
        type="button"
        aria-label="Reorder reminder"
        onPointerDown={handleDragHandlePointerDown}
        onClick={(e) => {
          e.stopPropagation();
          e.preventDefault();
        }}
      >
        <GripVertical size={18} strokeWidth={2} aria-hidden="true" />
      </button>
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
      className="reorderable-reminder-list"
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
