import React, { useCallback, useEffect, useRef, useState, forwardRef } from 'react';
import { motion, Reorder, useDragControls, useIsPresent } from 'framer-motion';
import type { Reminder } from '../types/reminder';
import { ReminderListPresence } from './ReminderListPresence';
import { REMINDER_DRAG_SCALE, REMINDER_LIST_LAYOUT_TRANSITION, REMINDER_SECTION_TRANSITION } from '../ui/layoutConstants';
import { reminderRowMotion } from '../ui/reminderRowMotion';
import { useObsidianReducedMotion } from '../ui/useObsidianReducedMotion';

interface ReorderableReminderListProps {
  reminders: Reminder[];
  onReorder: (reordered: Reminder[]) => void;
  onReorderCommit: (orderedIds: string[]) => void;
  onDragActiveChange?: (active: boolean) => void;
  renderCard: (reminder: Reminder, index: number) => React.ReactNode;
  interaction?: 'drag' | 'long-press';
  animationsEnabled?: boolean;
}

interface ReorderableItemProps {
  reminder: Reminder;
  index: number;
  renderCard: (reminder: Reminder, index: number) => React.ReactNode;
  onDragStart: () => void;
  onDragEnd: () => void;
  interaction: 'drag' | 'long-press';
  enableLayoutAnimations: boolean;
}

const LONG_PRESS_DELAY_MS = 380;
const LONG_PRESS_MOVE_TOLERANCE = 9;
const LONG_PRESS_INTERACTIVE_SELECTOR = 'button, a, input, textarea, select, [contenteditable="true"], [role="checkbox"]';

const LARGE_LIST_ANIMATION_LIMIT = 80;

const ReorderableItem = forwardRef<HTMLDivElement, ReorderableItemProps>(function ReorderableItem({ reminder, index, renderCard, onDragStart, onDragEnd, interaction, enableLayoutAnimations }: ReorderableItemProps, ref) {
  const isPresent = useIsPresent();
  const rowMotion = reminderRowMotion(enableLayoutAnimations);
  const [isDragPressed, setIsDragPressed] = useState(false);
  const didDragRef = useRef(false);
  const dragControls = useDragControls();
  const longPressTimerRef = useRef<number | null>(null);
  const pressStartRef = useRef<{ x: number; y: number } | null>(null);
  const [isLongPressArmed, setIsLongPressArmed] = useState(false);
  const [isReordering, setIsReordering] = useState(false);

  const cancelLongPress = useCallback(() => {
    if (longPressTimerRef.current !== null) {
      window.clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
    pressStartRef.current = null;
    setIsLongPressArmed(false);
    setIsDragPressed(false);
  }, []);

  useEffect(() => cancelLongPress, [cancelLongPress]);

  useEffect(() => {
    if (!isDragPressed && !isLongPressArmed) return;
    // A drag may be released outside the row, where its pointer-up won't bubble.
    window.addEventListener('pointerup', cancelLongPress);
    window.addEventListener('pointercancel', cancelLongPress);
    return () => {
      window.removeEventListener('pointerup', cancelLongPress);
      window.removeEventListener('pointercancel', cancelLongPress);
    };
  }, [cancelLongPress, isDragPressed, isLongPressArmed]);

  const handleDragStart = useCallback(() => {
    cancelLongPress();
    didDragRef.current = true;
    setIsReordering(true);
    onDragStart();
  }, [cancelLongPress, onDragStart]);

  const handleDragEnd = useCallback(() => {
    cancelLongPress();
    setIsReordering(false);
    onDragEnd();
    // Suppress the click event that fires after drag release
    // Use requestAnimationFrame so the flag clears after the click event
    window.requestAnimationFrame(() => {
      didDragRef.current = false;
    });
  }, [cancelLongPress, onDragEnd]);

  const handleClickCapture = useCallback((e: React.MouseEvent) => {
    if (didDragRef.current) {
      e.stopPropagation();
      e.preventDefault();
    }
  }, []);

  const handleItemPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (!event.isPrimary || event.button !== 0) return;
    const target = event.target as Element;
    if (target.closest(LONG_PRESS_INTERACTIVE_SELECTOR)) return;

    cancelLongPress();
    if (interaction === 'drag' && event.pointerType === 'mouse') {
      setIsDragPressed(true);
      dragControls.start(event);
      return;
    }
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
      {...rowMotion}
      ref={ref}
      as="div"
      dragMomentum={false}
      dragTransition={{
        bounceStiffness: REMINDER_LIST_LAYOUT_TRANSITION.stiffness,
        bounceDamping: REMINDER_LIST_LAYOUT_TRANSITION.damping,
      }}
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
      layout="position"
      layoutDependency={index}
      data-reminder-scroll-anchor={isPresent ? 'true' : undefined}
      aria-hidden={!isPresent || undefined}
      inert={!isPresent}
      data-reminder-id={reminder.id}
      data-reminder-section="active"
      data-reorder-interaction={interaction}
      className={`reorderable-reminder-item mb-2${isLongPressArmed ? ' is-long-press-armed' : ''}${isReordering ? ' is-reordering' : ''}`}
      whileDrag={{ zIndex: 50 }}
      transition={{
        layout: enableLayoutAnimations ? REMINDER_LIST_LAYOUT_TRANSITION : { duration: 0 },
        ...rowMotion.transition,
      }}
    >
      <motion.div
        className="reminder-drag-surface"
        initial={false}
        animate={{ scale: enableLayoutAnimations && (isDragPressed || isLongPressArmed || isReordering) ? REMINDER_DRAG_SCALE : 1 }}
        transition={enableLayoutAnimations ? REMINDER_SECTION_TRANSITION : { duration: 0 }}
        style={{ position: 'relative', display: 'flow-root' }}
      >
        {renderCard(reminder, index)}
      </motion.div>
    </Reorder.Item>
  );
});

export function ReorderableReminderList({
  reminders,
  onReorder,
  onReorderCommit,
  onDragActiveChange,
  renderCard,
  interaction = 'drag',
  animationsEnabled = true,
}: ReorderableReminderListProps) {
  const reduceMotion = useObsidianReducedMotion();
  const enableLayoutAnimations = animationsEnabled && !reduceMotion && reminders.length <= LARGE_LIST_ANIMATION_LIMIT;
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
      <ReminderListPresence>
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
      </ReminderListPresence>
    </Reorder.Group>
  );
}
