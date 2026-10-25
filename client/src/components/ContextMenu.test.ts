import { describe, expect, it } from 'vitest';
import { placeMenu } from './ContextMenu';

// PM-268: the menu stays inside the window, flipping above or left of the pointer when needed.

const view = { width: 1000, height: 800 };

describe('placeMenu', () => {
  it('opens below and right of the pointer when there is room', () => {
    expect(placeMenu(100, 100, 224, 300, view)).toEqual({ left: 100, top: 100 });
  });

  it('opens above the pointer near the bottom edge', () => {
    expect(placeMenu(100, 700, 224, 300, view)).toEqual({ left: 100, top: 400 });
  });

  it('opens left of the pointer near the right edge', () => {
    expect(placeMenu(900, 100, 224, 300, view).left).toBe(676);
  });

  it('pins to an edge when neither side fits', () => {
    expect(placeMenu(100, 200, 224, 700, view).top).toBe(96);
    expect(placeMenu(100, 400, 224, 900, view).top).toBe(4);
  });
});
