// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { ColumnChart } from './charts';

afterEach(cleanup);
it('reads columns by pointer position during a drag and clears on cancellation', () => {
  const { container } = render(
    <ColumnChart
      yTitle="Commits"
      xTitle="Dates"
      columns={['First', 'Second'].map((tip) => ({
        key: tip,
        short: tip,
        tip,
        segments: [{ id: 'a', value: 2, color: 'red' }],
      }))}
    />,
  );
  const plot = container.querySelector('.colchart-plot')!;
  container.querySelectorAll('.colchart-col').forEach((node, i) => {
    node.getBoundingClientRect = () => ({ left: i * 100, width: 100 }) as DOMRect;
  });
  const point = (type: string, x: number) => {
    const event = new Event(type, { bubbles: true });
    Object.defineProperties(event, {
      clientX: { value: x },
      pointerId: { value: 1 },
      pointerType: { value: 'touch' },
    });
    fireEvent(plot, event);
  };
  point('pointerdown', 20);
  expect(screen.getByRole('tooltip', { hidden: true }).textContent).toBe('First');
  point('pointermove', 180);
  expect(screen.getByRole('tooltip', { hidden: true }).textContent).toBe('Second');
  point('pointercancel', 180);
  expect(screen.queryByRole('tooltip', { hidden: true })).toBeNull();
  point('pointerdown', 20);
  point('pointerup', 20);
  expect(screen.queryByRole('tooltip', { hidden: true })).toBeNull();
});

it('clamps the tooltip inside the viewport when hovering edge columns on mobile', () => {
  const prevWidth = window.innerWidth;
  window.innerWidth = 360;
  const origRect = HTMLElement.prototype.getBoundingClientRect;
  HTMLElement.prototype.getBoundingClientRect = function () {
    if (this.classList.contains('tooltip')) {
      return { left: 0, top: 0, width: 180, height: 60 } as DOMRect;
    }
    return origRect.call(this);
  };
  try {
    const { container } = render(
      <ColumnChart
        yTitle="Commits"
        xTitle="Dates"
        columns={['LeftEdge', 'Middle', 'RightEdge'].map((tip) => ({
          key: tip,
          short: tip,
          tip,
          segments: [{ id: 'a', value: 5, color: 'red' }],
        }))}
      />,
    );
    const plot = container.querySelector('.colchart-plot')!;
    const rects = [
      { left: 20, top: 200, width: 20, height: 100 },
      { left: 170, top: 200, width: 20, height: 100 },
      { left: 330, top: 200, width: 20, height: 100 },
    ];
    container.querySelectorAll('.colchart-col').forEach((node, i) => {
      node.getBoundingClientRect = () => rects[i]! as DOMRect;
      const bar = node.querySelector('.colchart-bar')!;
      bar.getBoundingClientRect = () => rects[i]! as DOMRect;
    });
    const move = (x: number) => {
      const event = new Event('pointermove', { bubbles: true });
      Object.defineProperties(event, {
        clientX: { value: x },
        pointerId: { value: 1 },
        pointerType: { value: 'touch' },
      });
      fireEvent(plot, event);
    };
    // Left edge column (center x = 30) -> clamped to 8 + 180/2 = 98px
    move(30);
    const tip = screen.getByRole('tooltip', { hidden: true });
    expect(tip.textContent).toBe('LeftEdge');
    expect(tip.style.left).toBe('98px');

    // Right edge column (center x = 340) -> clamped to 360 - 8 - 180/2 = 262px
    move(340);
    expect(tip.textContent).toBe('RightEdge');
    expect(tip.style.left).toBe('262px');
  } finally {
    window.innerWidth = prevWidth;
    HTMLElement.prototype.getBoundingClientRect = origRect;
  }
});
