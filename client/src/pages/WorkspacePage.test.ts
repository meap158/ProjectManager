// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import type { WorkspaceLayout } from '../../../shared/types';
import { placeSession } from './WorkspacePage';

const layout = (preset: WorkspaceLayout['preset'], panes: (number | null)[]): WorkspaceLayout => ({
  preset,
  panes,
  maximized: null,
});

describe('placeSession (opening a session in the workspace)', () => {
  it('keeps a session that is already shown where it is', () => {
    const l = layout('2v', [1, 2]);
    expect(placeSession(l, 2)).toBe(l);
  });

  it('uses the first empty pane', () => {
    expect(placeSession(layout('2v', [1, null]), 7).panes).toEqual([1, 7]);
  });

  it('grows the layout when every pane is taken (1 → 2 → 2×2)', () => {
    const two = placeSession(layout('1', [1]), 2);
    expect(two).toMatchObject({ preset: '2v', panes: [1, 2] });
    const four = placeSession(two, 3);
    expect(four).toMatchObject({ preset: '2x2', panes: [1, 2, 3, null] });
  });

  it('replaces the last pane once the largest layout is full, and clears maximise', () => {
    const full: WorkspaceLayout = { preset: '2x2', panes: [1, 2, 3, 4], maximized: 0 };
    expect(placeSession(full, 9)).toEqual({ preset: '2x2', panes: [1, 2, 3, 9], maximized: null });
  });
});
