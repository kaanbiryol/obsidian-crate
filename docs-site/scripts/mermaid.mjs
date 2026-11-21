import { createHash } from 'node:crypto';
import { createMermaidRenderer } from 'mermaid-isomorphic';

// Renders ```mermaid blocks to static SVG at build time, once per site theme, so pages ship no
// diagram JavaScript. GitHub renders the same blocks natively in docs/.
// Arial is measured in the build browser; Linux CI uses the metric-compatible Liberation Sans.
const fontFamily = 'arial, sans-serif';
const themes = {
  light: {
    darkMode: false, background: '#ffffff', fontFamily, fontSize: '15px',
    primaryColor: '#f0eafa', primaryTextColor: '#19171e', primaryBorderColor: '#7253b7',
    secondaryColor: '#f6f5f8', tertiaryColor: '#faf9fc', lineColor: '#6f6979', textColor: '#19171e',
    clusterBkg: '#faf9fc', clusterBorder: '#aaa4b4', edgeLabelBackground: '#ffffff',
    actorBkg: '#f0eafa', actorBorder: '#7253b7', actorTextColor: '#19171e', actorLineColor: '#aaa4b4',
    signalColor: '#484351', signalTextColor: '#19171e', labelBoxBkgColor: '#f0eafa', labelBoxBorderColor: '#7253b7',
    labelTextColor: '#19171e', loopTextColor: '#19171e', noteBkgColor: '#f6f5f8', noteBorderColor: '#aaa4b4',
    noteTextColor: '#19171e', activationBkgColor: '#dfdbe5', activationBorderColor: '#7253b7', sequenceNumberColor: '#ffffff',
  },
  dark: {
    darkMode: true, background: '#0b0b0e', fontFamily, fontSize: '15px',
    primaryColor: '#211b35', primaryTextColor: '#f4f4f6', primaryBorderColor: '#8d70d4',
    secondaryColor: '#28272f', tertiaryColor: '#141418', lineColor: '#8c8a96', textColor: '#f4f4f6',
    clusterBkg: '#141418', clusterBorder: '#53515d', edgeLabelBackground: '#0b0b0e',
    actorBkg: '#211b35', actorBorder: '#8d70d4', actorTextColor: '#f4f4f6', actorLineColor: '#53515d',
    signalColor: '#bbb9c4', signalTextColor: '#f4f4f6', labelBoxBkgColor: '#211b35', labelBoxBorderColor: '#8d70d4',
    labelTextColor: '#f4f4f6', loopTextColor: '#f4f4f6', noteBkgColor: '#28272f', noteBorderColor: '#53515d',
    noteTextColor: '#f4f4f6', activationBkgColor: '#28272f', activationBorderColor: '#8d70d4', sequenceNumberColor: '#0b0b0e',
  },
};

const MIN_WIDTH = 560;
let renderer;

/** Replaces each `mermaid` code block with a light and a dark SVG; CSS shows the active theme's. */
export function remarkMermaid() {
  return async (tree, file) => {
    const blocks = [];
    (function visit(node, parent) {
      if (node.type === 'code' && node.lang === 'mermaid' && parent) blocks.push({ node, parent });
      node.children?.forEach(child => visit(child, node));
    })(tree);
    if (!blocks.length) return;
    renderer ??= createMermaidRenderer();
    const sources = blocks.map(({ node }) => node.value);
    // Unique ids per page and theme keep each SVG's scoped styles apart.
    const page = createHash('sha256').update(file.path ?? '').digest('hex').slice(0, 8);
    const rendered = {};
    for (const [theme, themeVariables] of Object.entries(themes)) {
      const results = await renderer(sources, {
        prefix: `diagram-${page}-${theme}`,
        mermaidConfig: { theme: 'base', themeVariables, fontFamily, securityLevel: 'strict', htmlLabels: false, flowchart: { htmlLabels: false, wrappingWidth: 320 } },
      });
      rendered[theme] = results.map((result, index) => {
        if (result.status === 'fulfilled') return result.value;
        throw new Error(`Could not render Mermaid diagram ${index + 1} in ${file.path}: ${result.reason?.message ?? result.reason}`);
      });
    }
    // On narrow screens a diagram keeps a readable minimum width and scrolls sideways.
    const panel = (theme, index) => {
      const { svg, width } = rendered[theme][index];
      return `<div class="crate-diagram-${theme}" style="min-width: ${Math.min(Math.ceil(width), MIN_WIDTH)}px">${svg}</div>`;
    };
    blocks.forEach(({ node, parent }, index) => {
      parent.children[parent.children.indexOf(node)] = {
        type: 'html',
        value: `<figure class="crate-diagram not-content">${panel('light', index)}${panel('dark', index)}</figure>`,
      };
    });
  };
}
