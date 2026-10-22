import { describe, expect, it } from 'vitest';
import { nextReadState } from './backpressure.ts';

describe('nextReadState (D-025)', () => {
  it('pauses reading at the cap and resumes at half of it', () => {
    expect(nextReadState(999, false, 1000)).toBeUndefined();
    expect(nextReadState(1000, false, 1000)).toBe('pause');
    expect(nextReadState(501, true, 1000)).toBeUndefined(); // still too much waiting
    expect(nextReadState(500, true, 1000)).toBe('resume');
  });

  it("doesn't flip back and forth around the cap (hysteresis)", () => {
    let paused = false;
    let flips = 0;
    for (const pending of [990, 1000, 999, 1001, 998, 1000, 700, 600, 501]) {
      const next = nextReadState(pending, paused, 1000);
      if (next) {
        paused = next === 'pause';
        flips++;
      }
    }
    expect(flips).toBe(1); // paused once at 1000, never resumed above 500
  });
});
