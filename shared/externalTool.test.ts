import { describe, expect, it } from 'vitest';
import { splitCommandTemplate, substituteArgv } from './externalTool';

describe('splitCommandTemplate', () => {
  it('splits on whitespace', () => {
    expect(splitCommandTemplate('gmic {in} -denoise_patchpca 5 -o {out},uint8')).toEqual([
      'gmic',
      '{in}',
      '-denoise_patchpca',
      '5',
      '-o',
      '{out},uint8',
    ]);
  });

  it('keeps a double-quoted token intact, spaces and all', () => {
    expect(splitCommandTemplate('"my tool" {in} --out {out}')).toEqual(['my tool', '{in}', '--out', '{out}']);
  });
});

describe('substituteArgv', () => {
  it('replaces a whole-token placeholder', () => {
    expect(substituteArgv(['{in}', '-o', '{out}'], '/tmp/in.tiff', '/tmp/out.tiff')).toEqual([
      '/tmp/in.tiff',
      '-o',
      '/tmp/out.tiff',
    ]);
  });

  it('replaces a placeholder GLUED to a suffix (gmic\'s "-o {out},uint8" output-type syntax)', () => {
    expect(substituteArgv(['-o', '{out},uint8'], '/tmp/in.tiff', '/tmp/out.tiff')).toEqual(['-o', '/tmp/out.tiff,uint8']);
  });

  it('replaces both {in} and {out} when they appear in the SAME token', () => {
    expect(substituteArgv(['{in}->{out}'], '/tmp/in.tiff', '/tmp/out.tiff')).toEqual(['/tmp/in.tiff->/tmp/out.tiff']);
  });

  it('leaves quoted-and-already-split tokens (no placeholder text) untouched', () => {
    expect(substituteArgv(['my tool', '{in}', '--out', '{out}'], '/tmp/in.tiff', '/tmp/out.tiff')).toEqual([
      'my tool',
      '/tmp/in.tiff',
      '--out',
      '/tmp/out.tiff',
    ]);
  });

  it('does not touch a token with no placeholder', () => {
    expect(substituteArgv(['-denoise_patchpca', '5'], '/tmp/in.tiff', '/tmp/out.tiff')).toEqual(['-denoise_patchpca', '5']);
  });
});
