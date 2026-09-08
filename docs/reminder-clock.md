# Time-dependent reminder views

Today, Upcoming, header counts, date labels and overdue indicators refresh independently of reminder data. The plugin and web app share the same clock hook, including embedded plugin reminder lists. A server response saying the snapshot is unchanged cannot keep yesterday's view on screen.

Mounted reminder components share one timer. It runs at minute boundaries or immediately after the next known timed deadline, whichever comes first. Focus, page restoration and visibility changes refresh the clock immediately after suspension. The minute check also detects manual clock and timezone changes while the app remains open. Timezone changes invalidate the calendar library's cached local timezone. Timers and listeners are removed after the last subscriber unmounts.

Calendar views use local dates, including 23- and 25-hour DST days. Saved reminder dates, UTC instants, recurrence rules and notification policy are unchanged by these display updates. Browser and operating-system timer throttling can delay background rendering; returning to the app refreshes it.

Six clock/model regressions cover midnight, exact timed deadlines, both DST day lengths, timezone-cache invalidation, clock jumps, resume and cleanup. The built-app browser gate verifies midnight plus real HTTP 304 responses, timed-deadline removal from Upcoming, overdue cards/header counts, relative labels and clock-jump recovery in Chromium and WebKit. Physical mobile background/resume acceptance remains a separate check.
