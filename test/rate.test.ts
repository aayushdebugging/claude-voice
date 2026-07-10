import { describe, it, expect } from 'vitest';

import { clampSpeed, parseSpeed, SPEED_MIN, SPEED_MAX } from '../src/utils/rate.js';

describe('clampSpeed', () => {
  it('passes through in-range values', () => {
    expect(clampSpeed(1)).toBe(1);
    expect(clampSpeed(1.5)).toBe(1.5);
  });

  it('clamps to the safe range', () => {
    expect(clampSpeed(0.1)).toBe(SPEED_MIN);
    expect(clampSpeed(10)).toBe(SPEED_MAX);
  });

  it('treats undefined / non-finite as natural (1)', () => {
    expect(clampSpeed(undefined)).toBe(1);
    expect(clampSpeed(NaN)).toBe(1);
    expect(clampSpeed(Infinity)).toBe(1);
  });
});

describe('parseSpeed', () => {
  it('parses plain numbers and the "x" suffix', () => {
    expect(parseSpeed('1.5')).toBe(1.5);
    expect(parseSpeed('2x')).toBe(2);
    expect(parseSpeed('1.25X')).toBe(1.25);
    expect(parseSpeed(' 2 ')).toBe(2);
  });

  it('clamps parsed values', () => {
    expect(parseSpeed('9')).toBe(SPEED_MAX);
    expect(parseSpeed('0')).toBe(SPEED_MIN);
  });

  it('returns null for non-numeric input', () => {
    expect(parseSpeed('fast')).toBeNull();
    expect(parseSpeed('')).toBeNull();
    expect(parseSpeed('1.5.5')).toBeNull();
  });
});
