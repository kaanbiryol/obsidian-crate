import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PWA_FADE, PWA_FADE_TIMING } from './motion';

const tokens = readFileSync(new URL('../styles/_navigation-motion.scss', import.meta.url), 'utf8');
const token = (name: string) => tokens.match(new RegExp(`--${name}:\\s*([^;]+);`))?.[1]?.trim();

describe('shared fade', () => {
	it('matches the CSS fade tokens, so every fade has one timing', () => {
		expect(token('pwa-motion-fade-duration')).toBe(`${PWA_FADE.duration * 1000}ms`);
		expect(token('pwa-motion-fade-ease')).toBe(PWA_FADE_TIMING.easing);
		expect(PWA_FADE_TIMING.duration).toBe(PWA_FADE.duration * 1000);
	});
});
