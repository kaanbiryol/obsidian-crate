import type { ReactNode } from 'react';
import { AnimatePresence } from 'framer-motion';

/** Rows keep their space during exits; their height animation closes the gap. */
export function ReminderListPresence({ children }: { children: ReactNode }) {
  return (
    <div className="reminder-list-presence" style={{ display: 'flow-root' }}>
      <AnimatePresence initial={false}>
        {children}
      </AnimatePresence>
    </div>
  );
}
