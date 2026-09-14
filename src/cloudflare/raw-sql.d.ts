declare module '*.sql?raw' {
  const text: string;
  export default text;
}

interface ImportMeta {
  glob: import('vite/types/importGlob').ImportGlobFunction;
}
