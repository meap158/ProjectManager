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
