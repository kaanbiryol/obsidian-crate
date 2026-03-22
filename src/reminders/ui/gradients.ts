export type GlowShape = 'circle' | 'ellipse';

export interface SoftGlowOptions {
    shape?: GlowShape;
    /**
     * Intensity of the glow (0..1). Higher = brighter.
     * Kept low to avoid banding on dark backgrounds.
     */
    strength?: number;
    /**
     * How far the glow fades out (0..1).
     * Higher = larger, softer glow.
     */
    spread?: number;
}

const clamp = (value: number, min: number, max: number): number => {
    return Math.min(max, Math.max(min, value));
};

const mix = (color: string, percent: number): string => {
    return `color-mix(in srgb, ${color} ${percent}%, transparent)`;
};

/**
 * High-quality radial glow with multiple stops to reduce banding.
 * Uses color-mix so it works with hex, hsl(), or CSS variables.
 */
export const softRadialGlow = (color: string, options: SoftGlowOptions = {}): string => {
    const shape = options.shape ?? 'ellipse';
    const strength = clamp(options.strength ?? 0.16, 0.04, 0.6);
    const spread = clamp(options.spread ?? 0.78, 0.6, 0.9);

    const core = strength * 100;
    const mid = strength * 0.65 * 100;
    const soft = strength * 0.35 * 100;
    const edge = strength * 0.18 * 100;
    const spreadPercent = Math.round(spread * 100);

    return [
        `radial-gradient(${shape} at center`,
        `${mix(color, core)} 0%`,
        `${mix(color, mid)} 35%`,
        `${mix(color, soft)} 55%`,
        `${mix(color, edge)} 70%`,
        `transparent ${spreadPercent}%)`
    ].join(', ');
};
