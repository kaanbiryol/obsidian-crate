/**
 * Curated 50-color project palette
 * Gem-inspired colors optimized for both light and dark Obsidian themes
 * Each color has been hand-tuned for distinguishability and visual harmony
 */

/**
 * Project color definition with theme variants
 */
interface ProjectColorDef {
    name: string;
    light: string;  // Hex for light mode
    dark: string;   // Hex for dark mode
}

/**
 * The curated 50-color palette
 * Colors distributed across the spectrum to maximize visual distinction
 */
const PROJECT_COLORS: ProjectColorDef[] = [
    // ═══════════════════════════════════════════════════════════════
    // REDS & PINKS (8 colors)
    // ═══════════════════════════════════════════════════════════════
    { name: 'ruby',        light: '#dc2626', dark: '#f87171' },  // Classic red
    { name: 'coral',       light: '#f97316', dark: '#fb923c' },  // Orange-red
    { name: 'rose',        light: '#e11d48', dark: '#fb7185' },  // Pink-red
    { name: 'blush',       light: '#ec4899', dark: '#f472b6' },  // Soft pink
    { name: 'magenta',     light: '#c026d3', dark: '#e879f9' },  // Vibrant pink
    { name: 'cerise',      light: '#be185d', dark: '#f43f5e' },  // Deep pink
    { name: 'watermelon',  light: '#f43f5e', dark: '#fda4af' },  // Fresh pink-red
    { name: 'flamingo',    light: '#fb7185', dark: '#fecdd3' },  // Pale pink

    // ═══════════════════════════════════════════════════════════════
    // ORANGES & AMBERS (6 colors)
    // ═══════════════════════════════════════════════════════════════
    { name: 'tangerine',   light: '#ea580c', dark: '#fb923c' },  // True orange
    { name: 'amber',       light: '#d97706', dark: '#fbbf24' },  // Golden orange
    { name: 'honey',       light: '#b45309', dark: '#f59e0b' },  // Warm amber
    { name: 'marigold',    light: '#ca8a04', dark: '#facc15' },  // Yellow-orange
    { name: 'peach',       light: '#c2410c', dark: '#fdba74' },  // Soft orange
    { name: 'apricot',     light: '#ea580c', dark: '#fed7aa' },  // Light orange

    // ═══════════════════════════════════════════════════════════════
    // YELLOWS & LIMES (5 colors)
    // ═══════════════════════════════════════════════════════════════
    { name: 'gold',        light: '#a16207', dark: '#fde047' },  // Rich gold
    { name: 'lemon',       light: '#a3a207', dark: '#fef08a' },  // Bright yellow
    { name: 'canary',      light: '#84cc16', dark: '#bef264' },  // Yellow-green
    { name: 'lime',        light: '#65a30d', dark: '#a3e635' },  // Vibrant lime
    { name: 'chartreuse',  light: '#4d7c0f', dark: '#84cc16' },  // Deep lime

    // ═══════════════════════════════════════════════════════════════
    // GREENS (8 colors)
    // ═══════════════════════════════════════════════════════════════
    { name: 'emerald',     light: '#059669', dark: '#34d399' },  // Classic green
    { name: 'jade',        light: '#047857', dark: '#6ee7b7' },  // Blue-green
    { name: 'mint',        light: '#10b981', dark: '#a7f3d0' },  // Fresh mint
    { name: 'sage',        light: '#4d7c0f', dark: '#86efac' },  // Muted green
    { name: 'forest',      light: '#166534', dark: '#22c55e' },  // Deep green
    { name: 'spring',      light: '#16a34a', dark: '#4ade80' },  // Bright green
    { name: 'clover',      light: '#15803d', dark: '#86efac' },  // Lucky green
    { name: 'fern',        light: '#14532d', dark: '#bbf7d0' },  // Dark green

    // ═══════════════════════════════════════════════════════════════
    // TEALS & CYANS (6 colors)
    // ═══════════════════════════════════════════════════════════════
    { name: 'teal',        light: '#0d9488', dark: '#2dd4bf' },  // Classic teal
    { name: 'turquoise',   light: '#0891b2', dark: '#22d3ee' },  // Blue-teal
    { name: 'aqua',        light: '#06b6d4', dark: '#67e8f9' },  // Bright cyan
    { name: 'seafoam',     light: '#0e7490', dark: '#a5f3fc' },  // Soft cyan
    { name: 'ocean',       light: '#155e75', dark: '#06b6d4' },  // Deep teal
    { name: 'lagoon',      light: '#164e63', dark: '#22d3ee' },  // Dark teal

    // ═══════════════════════════════════════════════════════════════
    // BLUES (8 colors)
    // ═══════════════════════════════════════════════════════════════
    { name: 'azure',       light: '#0284c7', dark: '#38bdf8' },  // Sky blue
    { name: 'cobalt',      light: '#2563eb', dark: '#60a5fa' },  // True blue
    { name: 'sapphire',    light: '#1d4ed8', dark: '#3b82f6' },  // Classic blue
    { name: 'royal',       light: '#1e40af', dark: '#6366f1' },  // Deep blue
    { name: 'navy',        light: '#1e3a8a', dark: '#818cf8' },  // Dark blue
    { name: 'sky',         light: '#0369a1', dark: '#7dd3fc' },  // Light blue
    { name: 'steel',       light: '#475569', dark: '#94a3b8' },  // Blue-gray
    { name: 'denim',       light: '#1d4ed8', dark: '#93c5fd' },  // Faded blue

    // ═══════════════════════════════════════════════════════════════
    // PURPLES & VIOLETS (6 colors)
    // ═══════════════════════════════════════════════════════════════
    { name: 'violet',      light: '#7c3aed', dark: '#a78bfa' },  // True violet
    { name: 'amethyst',    light: '#8b5cf6', dark: '#c4b5fd' },  // Soft purple
    { name: 'grape',       light: '#6d28d9', dark: '#a855f7' },  // Deep purple
    { name: 'plum',        light: '#9333ea', dark: '#d8b4fe' },  // Rich purple
    { name: 'orchid',      light: '#a855f7', dark: '#e9d5ff' },  // Light purple
    { name: 'iris',        light: '#6366f1', dark: '#a5b4fc' },  // Blue-purple

    // ═══════════════════════════════════════════════════════════════
    // NEUTRALS & SPECIAL (3 colors)
    // ═══════════════════════════════════════════════════════════════
    { name: 'slate',       light: '#64748b', dark: '#cbd5e1' },  // Cool gray
    { name: 'graphite',    light: '#374151', dark: '#9ca3af' },  // Warm gray
    { name: 'bronze',      light: '#92400e', dark: '#d97706' },  // Metallic warm
];

/**
 * Simple hash function to convert string to a number
 * Same input will always produce the same output
 */
function hashString(str: string): number {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        const char = str.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash; // Convert to 32-bit integer
    }
    return Math.abs(hash);
}

/**
 * Convert hex color to RGB string for use with rgba()
 * @param hex - Hex color string (e.g., '#dc2626')
 * @returns RGB string (e.g., '220, 38, 38')
 */
function hexToRgb(hex: string): string {
    const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    if (!result) return '0, 0, 0';
    return `${parseInt(result[1], 16)}, ${parseInt(result[2], 16)}, ${parseInt(result[3], 16)}`;
}

/**
 * Project color configuration returned by getProjectColor
 */
export interface ProjectColorConfig {
    /** Color name from the palette (e.g., 'ruby', 'emerald') */
    name: string;
    /** Theme-aware color values */
    light: {
        /** Primary accent color hex */
        accent: string;
        /** RGB values for rgba() usage */
        accentRgb: string;
        /** Soft background color (accent at 10% opacity) */
        background: string;
        /** Text color (same as accent for light mode) */
        text: string;
    };
    dark: {
        /** Primary accent color hex */
        accent: string;
        /** RGB values for rgba() usage */
        accentRgb: string;
        /** Soft background color (accent at 15% opacity) */
        background: string;
        /** Text color (same as accent for dark mode) */
        text: string;
    };
}

/**
 * Get deterministic color configuration for a project name
 * The same project name will always return the same color
 *
 * @param projectName - The project name/tag (e.g., "work", "personal")
 * @returns Color configuration with theme-aware hex values and RGB strings
 *
 * @example
 * const colors = getProjectColor('work');
 * // In light mode: colors.light.accent = '#dc2626'
 * // In dark mode: colors.dark.accent = '#f87171'
 */
export function getProjectColor(projectName: string): ProjectColorConfig {
    // Ensure projectName is a string and handle edge cases
    const safeProjectName = String(projectName || 'Inbox');

    // Normalize the project name (remove # prefix if present, lowercase)
    const normalized = safeProjectName.replace(/^#/, '').toLowerCase().trim();

    // Hash the normalized name to get a consistent index
    const hash = hashString(normalized);
    const index = hash % PROJECT_COLORS.length;
    const color = PROJECT_COLORS[index];

    // Generate RGB strings for rgba() usage
    const lightRgb = hexToRgb(color.light);
    const darkRgb = hexToRgb(color.dark);

    return {
        name: color.name,
        light: {
            accent: color.light,
            accentRgb: lightRgb,
            background: `rgba(${lightRgb}, 0.1)`,
            text: color.light,
        },
        dark: {
            accent: color.dark,
            accentRgb: darkRgb,
            background: `rgba(${darkRgb}, 0.15)`,
            text: color.dark,
        },
    };
}
