import { describe, expect, it } from 'vitest';
import { ACR_LOOK_IN_SOURCE_PICKER, showAcrLookOption } from './profileSourceOptions';

describe('showAcrLookOption', () => {
  it('is hidden from the picker by default (decision 0003)', () => {
    expect(ACR_LOOK_IN_SOURCE_PICKER).toBe(false);
    expect(showAcrLookOption(true, 'builtin')).toBe(false);
    expect(showAcrLookOption(true, 'dcp')).toBe(false);
  });

  it('stays visible for a doc that already uses acrlook', () => {
    expect(showAcrLookOption(true, 'acrlook')).toBe(true);
    expect(showAcrLookOption(false, 'acrlook')).toBe(true);
  });

  it('restores the old rule when the flag is turned back on', () => {
    expect(showAcrLookOption(true, 'builtin', true)).toBe(true);
    expect(showAcrLookOption(false, 'builtin', true)).toBe(false);
  });
});
