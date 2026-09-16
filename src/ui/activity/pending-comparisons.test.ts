import { describe, expect, it, vi } from 'vitest';
import { PendingComparisons } from './pending-comparisons';
import type { PendingDiff } from '../../sync/pending-diff';

const snapshot: PendingDiff = { before: 'old', after: 'new', beforeSize: 3, afterSize: 3, kind: 'modified' };
function deferred() {
    let resolve!: (value: PendingDiff) => void;
    const promise = new Promise<PendingDiff>(done => { resolve = done; });
    return { promise, resolve };
}

describe('background pending comparisons', () => {
    it('checks at most two files at once and shares in-flight work with selection', async () => {
        const tasks = [deferred(), deferred(), deferred()];
        const load = vi.fn((index: number) => tasks[index]!.promise);
        const result = vi.fn();
        const comparisons = new PendingComparisons(3, load, result, vi.fn());
        comparisons.start();
        await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(2));
        const selected = comparisons.read(0);
        expect(load).toHaveBeenCalledTimes(2);
        tasks[0]!.resolve(snapshot);
        await expect(selected).resolves.toEqual(snapshot);
        await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(3));
        tasks[1]!.resolve(snapshot);
        tasks[2]!.resolve(snapshot);
        await vi.waitFor(() => expect(result).toHaveBeenCalledTimes(3));
        await comparisons.read(0);
        expect(load).toHaveBeenCalledTimes(3);
        comparisons.dispose();
    });

    it('continues after a failed file and supports an explicit retry', async () => {
        const load = vi.fn().mockRejectedValueOnce(new Error('Offline')).mockResolvedValue(snapshot);
        const error = vi.fn(), result = vi.fn();
        const comparisons = new PendingComparisons(3, load, result, error);
        comparisons.start();
        await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(3));
        await vi.waitFor(() => expect(error).toHaveBeenCalledWith(0));
        await expect(comparisons.read(0)).resolves.toEqual(snapshot);
        expect(load).toHaveBeenCalledTimes(4);
        comparisons.dispose();
    });

    it('pauses queued checks when leaving Pending and resumes on return', async () => {
        const first = deferred();
        const load = vi.fn().mockReturnValue(first.promise);
        const result = vi.fn();
        const comparisons = new PendingComparisons(4, load, result, vi.fn());
        comparisons.start();
        await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(2));
        comparisons.pause();
        first.resolve(snapshot);
        await vi.waitFor(() => expect(result).toHaveBeenCalledTimes(2));
        expect(load).toHaveBeenCalledTimes(2);
        comparisons.start();
        await vi.waitFor(() => expect(result).toHaveBeenCalledTimes(4));
        comparisons.dispose();
    });

    it('does not load more files or update the UI after disposal', async () => {
        const first = deferred();
        const load = vi.fn().mockReturnValue(first.promise);
        const result = vi.fn();
        const comparisons = new PendingComparisons(10, load, result, vi.fn());
        comparisons.start();
        await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(2));
        comparisons.dispose();
        first.resolve(snapshot);
        await first.promise;
        await expect(comparisons.read(0)).rejects.toThrow('closed');
        expect(result).not.toHaveBeenCalled();
        expect(load).toHaveBeenCalledTimes(2);
    });

    it('bounds cached content and reloads evicted files', async () => {
        const large = { ...snapshot, before: 'a'.repeat(250_000), after: 'b'.repeat(250_000) };
        const load = vi.fn(async () => large);
        const comparisons = new PendingComparisons(3, load, vi.fn(), vi.fn());
        await comparisons.read(0);
        await comparisons.read(1);
        await comparisons.read(2);
        await comparisons.read(2);
        expect(load).toHaveBeenCalledTimes(3);
        await comparisons.read(0); // The oldest half-million characters were evicted.
        expect(load).toHaveBeenCalledTimes(4);
        comparisons.dispose();
    });
});
