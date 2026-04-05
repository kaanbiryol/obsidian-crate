import React, { useCallback, useRef } from 'react';
import { Reorder, useDragControls } from 'framer-motion';
import { GripVertical } from 'lucide-react';
import type { Reminder } from '../types/reminder';

interface ReorderableReminderListProps {
  reminders: Reminder[];
  onReorder: (reordered: Reminder[]) => void;
  onReorderCommit: (orderedIds: string[]) => void;
  renderCard: (reminder: Reminder, index: number) => React.ReactNode;
}

interface ReorderableItemProps {
  reminder: Reminder;
  index: number;
  renderCard: (reminder: Reminder, index: number) => React.ReactNode;
  onDragEnd: () => void;
}

function ReorderableItem({ reminder, index, renderCard, onDragEnd }: ReorderableItemProps) {
  const controls = useDragControls();

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    controls.start(e);
  }, [controls]);

  return (
    <Reorder.Item
      as="div"
      value={reminder}
      dragListener={false}
      dragControls={controls}
      onDragEnd={onDragEnd}
      style={{ marginBottom: '0.5rem' }}
      whileDrag={{
        scale: 1.02,
        boxShadow: '0 8px 24px rgba(0, 0, 0, 0.2)',
        zIndex: 50,
      }}
      transition={{
        layout: { type: 'spring', stiffness: 350, damping: 35 },
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
        <div
          onPointerDown={handlePointerDown}
          className="reorder-drag-handle"
          style={{
            cursor: 'grab',
            touchAction: 'none',
            padding: '4px 0',
            color: 'var(--text-faint, rgba(255,255,255,0.3))',
            flexShrink: 0,
            display: 'flex',
            alignItems: 'center',
          }}
        >
          <GripVertical size={16} />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          {renderCard(reminder, index)}
        </div>
      </div>
    </Reorder.Item>
  );
}

export function ReorderableReminderList({
  reminders,
  onReorder,
  onReorderCommit,
  renderCard,
}: ReorderableReminderListProps) {
  const latestOrderRef = useRef(reminders);
  latestOrderRef.current = reminders;

  const handleDragEnd = useCallback(() => {
    onReorderCommit(latestOrderRef.current.map(r => r.id));
  }, [onReorderCommit]);

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
          onDragEnd={handleDragEnd}
        />
      ))}
    </Reorder.Group>
  );
}
