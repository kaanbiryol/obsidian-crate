import { useState, useEffect, useCallback } from 'react';
import { PluginContext } from '@/reminders/ui/reminders-context';

/**
 * Hook that subscribes to ReminderIndex changes and triggers re-renders.
 *
 * Returns a refreshToken that changes whenever the index updates (from file changes)
 * and a triggerRefresh function for manual refresh (e.g., after user actions).
 *
 * Usage:
 * ```tsx
 * const { refreshToken, triggerRefresh } = useIndexRefresh();
 *
 * useEffect(() => {
 *   // Load data when refreshToken changes
 * }, [refreshToken]);
 * ```
 */
export function useIndexRefresh(): {
  refreshToken: number;
  triggerRefresh: () => void;
} {
  const plugin = PluginContext.use();
  const [refreshToken, setRefreshToken] = useState(0);

  const triggerRefresh = useCallback(() => {
    setRefreshToken(prev => prev + 1);
  }, []);

  useEffect(() => {
    // Subscribe to index changes
    if (plugin.reminderIndex) {
      const unsubscribe = plugin.reminderIndex.onIndexChange(() => {
        triggerRefresh();
      });

      return unsubscribe;
    }
  }, [plugin.reminderIndex, triggerRefresh]);

  return { refreshToken, triggerRefresh };
}
