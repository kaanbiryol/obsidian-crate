import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import runtime from './worker-runtime.json';

interface WranglerConfig {
	compatibility_date: string;
	compatibility_flags: string[];
	d1_databases: Array<{ binding: string }>;
	r2_buckets: Array<{ binding: string }>;
	durable_objects: { bindings: Array<{ name: string; class_name: string }> };
	exports: Record<string, unknown>;
	ratelimits: Array<{ name: string; simple: unknown }>;
}

// wrangler.jsonc cannot import the shared settings, so check it against them.
it('runs the development and test Worker with the deployed runtime settings', () => {
	const wrangler = JSON.parse(readFileSync('wrangler.jsonc', 'utf8')) as WranglerConfig;
	expect(wrangler.compatibility_date).toBe(runtime.compatibilityDate);
	expect(wrangler.compatibility_flags).toEqual(runtime.compatibilityFlags);
	expect(wrangler.d1_databases.map(binding => binding.binding)).toEqual([runtime.bindings.database]);
	expect(wrangler.r2_buckets.map(binding => binding.binding)).toEqual([runtime.bindings.bucket]);
	expect(wrangler.durable_objects.bindings).toEqual([{ name: runtime.bindings.reminderAlarms, class_name: runtime.durableObjectClass }]);
	expect(Object.keys(wrangler.exports)).toEqual([runtime.durableObjectClass]);
	expect(wrangler.ratelimits.map(({ name, simple }) => ({ name, simple }))).toEqual([{ name: runtime.bindings.notificationRateLimiter, simple: runtime.notificationRateLimit }]);
});
