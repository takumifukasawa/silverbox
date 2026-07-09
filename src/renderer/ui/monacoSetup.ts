/**
 * Monaco setup: worker environment + a small self-made WGSL Monarch grammar
 * (Monaco has no builtin WGSL). Everything bundles locally — the editor core
 * from the monaco-editor package, the worker via Vite's `?worker` import.
 */
import * as monaco from 'monaco-editor';
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';

self.MonacoEnvironment = {
  // only the generic worker — 'wgsl' is a custom language with no service
  getWorker: () => new EditorWorker(),
};

monaco.languages.register({ id: 'wgsl' });

monaco.languages.setLanguageConfiguration('wgsl', {
  comments: { lineComment: '//', blockComment: ['/*', '*/'] },
  brackets: [
    ['{', '}'],
    ['[', ']'],
    ['(', ')'],
  ],
  autoClosingPairs: [
    { open: '{', close: '}' },
    { open: '[', close: ']' },
    { open: '(', close: ')' },
  ],
});

monaco.languages.setMonarchTokensProvider('wgsl', {
  defaultToken: '',
  keywords: [
    'fn', 'let', 'var', 'const', 'return', 'if', 'else', 'for', 'while', 'loop',
    'break', 'continue', 'continuing', 'switch', 'case', 'default', 'discard',
    'struct', 'true', 'false', 'override', 'alias', 'enable',
  ],
  types: [
    'bool', 'f16', 'f32', 'i32', 'u32',
    'vec2f', 'vec3f', 'vec4f', 'vec2i', 'vec3i', 'vec4i', 'vec2u', 'vec3u', 'vec4u',
    'vec2', 'vec3', 'vec4', 'mat2x2', 'mat3x3', 'mat4x4', 'mat2x2f', 'mat3x3f', 'mat4x4f',
    'array', 'atomic', 'ptr', 'sampler', 'texture_2d',
  ],
  builtins: [
    'abs', 'acos', 'asin', 'atan', 'atan2', 'ceil', 'clamp', 'cos', 'cross',
    'degrees', 'distance', 'dot', 'exp', 'exp2', 'floor', 'fract', 'inverseSqrt',
    'length', 'log', 'log2', 'max', 'min', 'mix', 'normalize', 'pow', 'radians',
    'reflect', 'round', 'saturate', 'select', 'sign', 'sin', 'smoothstep', 'sqrt',
    'step', 'tan', 'textureLoad', 'trunc',
    // engine-provided helpers
    'luma', 'srgbEncode', 'srgbEncode1',
  ],
  tokenizer: {
    root: [
      [/\/\/.*$/, 'comment'],
      [/\/\*/, 'comment', '@comment'],
      [/@[a-zA-Z_]\w*/, 'annotation'],
      [
        /[a-zA-Z_]\w*/,
        { cases: { '@keywords': 'keyword', '@types': 'type', '@builtins': 'predefined', '@default': 'identifier' } },
      ],
      [/0[xX][0-9a-fA-F]+[iu]?/, 'number.hex'],
      [/\d+\.\d*([eE][-+]?\d+)?[fh]?/, 'number.float'],
      [/\.\d+([eE][-+]?\d+)?[fh]?/, 'number.float'],
      [/\d+[fh]/, 'number.float'],
      [/\d+[iu]?/, 'number'],
      [/[{}()[\]]/, '@brackets'],
      [/[;,.]/, 'delimiter'],
      [/[-+*/%&|^!=<>]=?/, 'operator'],
    ],
    comment: [
      [/[^/*]+/, 'comment'],
      [/\*\//, 'comment', '@pop'],
      [/[/*]/, 'comment'],
    ],
  },
});

// verify-harness hook: lets Playwright drive the editor model directly
declare global {
  interface Window {
    __monaco?: typeof monaco;
  }
}
window.__monaco = monaco;

export { monaco };
