import React, { useCallback, useEffect, useRef, useState } from 'react';
import { motion, Reorder, useDragControls } from 'framer-motion';
import { GripVertical } from 'lucide-react';
import type { Reminder } from '../types/reminder';
import { REMINDER_LIST_LAYOUT_TRANSITION } from '../ui/layoutConstants';

interface ReorderableReminderListProps {
  reminders: Reminder[];
  onReorder: (reordered: Reminder[]) => void;
  onReorderCommit: (orderedIds: string[]) => void;
  onDragActiveChange?: (active: boolean) => void;
  renderCard: (reminder: Reminder, index: number) => React.ReactNode;
  interaction?: 'handle' | 'long-press';
}

interface ReorderableItemProps {
  reminder: Reminder;
  index: number;
  renderCard: (reminder: Reminder, index: number) => React.ReactNode;
  onDragStart: () => void;
  onDragEnd: () => void;
  interaction: 'handle' | 'long-press';
	enableLayoutAnimations: boolean;
}

const LONG_PRESS_DELAY_MS = 380;
const LONG_PRESS_MOVE_TOLERANCE = 9;
const LONG_PRESS_INTERACTIVE_SELECTOR = 'button, a, input, textarea, select, [contenteditable="true"], [role="checkbox"]';

const LARGE_LIST_ANIMATION_LIMIT = 80;

function ReorderableItem({ reminder, index, renderCard, onDragStart, onDragEnd, interaction, enableLayoutAnimations }: ReorderableItemProps) {
  const didDragRef = useRef(false);
  const dragControls = useDragControls();
  const longPressTimerRef = useRef<number | null>(null);
  const pressStartRef = useRef<{ x: number; y: number } | null>(null);
  const [isLongPressArmed, setIsLongPressArmed] = useState(false);
  const [isReordering, setIsReordering] = useState(false);
  const isLifted = isLongPressArmed || isReordering;
  const usesLongPress = interaction === 'long-press';

  const cancelLongPress = useCallback(() => {
    if (longPressTimerRef.current !== null) {
      window.clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
    pressStartRef.current = null;
    setIsLongPressArmed(false);
  }, []);

  useEffect(() => cancelLongPress, [cancelLongPress]);

  const handleDragStart = useCallback(() => {
    cancelLongPress();
    didDragRef.current = true;
    setIsReordering(true);
    onDragStart();
  }, [cancelLongPress, onDragStart]);

  const handleDragEnd = useCallback(() => {
    setIsReordering(false);
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

  const handleItemPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (interaction !== 'long-press' || !event.isPrimary || event.button !== 0) return;
    const target = event.target as Element;
    if (target.closest(LONG_PRESS_INTERACTIVE_SELECTOR)) return;

    cancelLongPress();
    pressStartRef.current = { x: event.clientX, y: event.clientY };
    longPressTimerRef.current = window.setTimeout(() => {
      longPressTimerRef.current = null;
      pressStartRef.current = null;
      setIsLongPressArmed(true);
      dragControls.start(event);
    }, LONG_PRESS_DELAY_MS);
  }, [cancelLongPress, dragControls, interaction]);

  const handleItemPointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const start = pressStartRef.current;
    if (!start) return;
    if (
      Math.abs(event.clientX - start.x) > LONG_PRESS_MOVE_TOLERANCE
      || Math.abs(event.clientY - start.y) > LONG_PRESS_MOVE_TOLERANCE
    ) {
      cancelLongPress();
    }
  }, [cancelLongPress]);

  return (
    <Reorder.Item
      as="div"
      value={reminder}
      dragListener={false}
      dragControls={dragControls}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onClickCapture={handleClickCapture}
      onPointerDown={handleItemPointerDown}
      onPointerMove={handleItemPointerMove}
      onPointerUp={cancelLongPress}
      onPointerCancel={cancelLongPress}
      onContextMenu={interaction === 'long-press' ? (event) => event.preventDefault() : undefined}
	  layout={enableLayoutAnimations ? 'position' : undefined}
      layoutDependency={index}
      data-reminder-scroll-anchor="true"
      data-reminder-id={reminder.id}
      data-reminder-section="active"
      data-reorder-interaction={interaction}
      className={`reorderable-reminder-item mb-2${isLongPressArmed ? ' is-long-press-armed' : ''}${isReordering ? ' is-reordering' : ''}`}
      animate={usesLongPress ? { scale: isLifted ? 1.02 : 1 } : undefined}
      whileTap={usesLongPress ? undefined : { scale: 1 }}
      whileDrag={usesLongPress ? { zIndex: 50 } : { scale: 1.02, zIndex: 50 }}
      transition={usesLongPress
        ? {
            layout: REMINDER_LIST_LAYOUT_TRANSITION,
            scale: { type: 'spring', stiffness: 420, damping: 31, mass: 0.68 },
          }
        : {
            layout: REMINDER_LIST_LAYOUT_TRANSITION,
          }}
    >
      <motion.div
        layoutId={`reminder-card-${reminder.id}`}
        layoutCrossfade={false}
		layout={enableLayoutAnimations ? 'position' : false}
        layoutDependency={reminder.id}
        transition={{ layout: REMINDER_LIST_LAYOUT_TRANSITION }}
      >
        {renderCard(reminder, index)}
      </motion.div>
      {interaction === 'handle' && (
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
      )}
    </Reorder.Item>
  );
}

export function ReorderableReminderList({
  reminders,
  onReorder,
  onReorderCommit,
  onDragActiveChange,
  renderCard,
  interaction = 'handle',
}: ReorderableReminderListProps) {
	const enableLayoutAnimations = reminders.length <= LARGE_LIST_ANIMATION_LIMIT;
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
          interaction={interaction}
		  enableLayoutAnimations={enableLayoutAnimations}
        />
      ))}
    </Reorder.Group>
  );
}
