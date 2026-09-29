import type { ReactNode } from 'react';
import { RemindersRuntimeProvider } from '../components/RemindersRuntime';
import { ReadingRuntimeProvider } from '../reading/ReadingRuntime';
import { SyncFeedbackProvider } from './SyncFeedback';

/** Own both feature runtimes for the whole app lifetime, independently of lazy views. */
export function PwaSyncProvider({ children }: { children: ReactNode }) {
	return <SyncFeedbackProvider><RemindersRuntimeProvider><ReadingRuntimeProvider>{children}</ReadingRuntimeProvider></RemindersRuntimeProvider></SyncFeedbackProvider>;
}
