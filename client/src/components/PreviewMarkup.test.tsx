// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { scaleShapes, type Shape } from './Markup';
import { PreviewMarkup } from './PreviewMarkup';
import { captureSize, pageContext } from './PreviewPickDialog';

beforeAll(() => {
  globalThis.ResizeObserver = class {
    observe() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  HTMLCanvasElement.prototype.getContext = (() => null) as never;
});
afterEach(cleanup);

const page = {
  url: 'http://p3000.localhost:5180/reports',
  title: 'OmniProbe',
  viewport: { width: 1000, height: 700, dark: false },
  scroll: { x: 0, y: 420, inner: null },
};

describe('marking up the live page (PM-311)', () => {
  it('scales marks from page pixels into the screenshot, and words a marks-only message', () => {
    const marks: Shape[] = [
      { kind: 'box', color: 'red', from: { x: 10, y: 20 }, to: { x: 30, y: 40 } },
      { kind: 'text', color: 'red', at: { x: 5, y: 5 }, text: 'here' },
    ];
    expect(scaleShapes(marks, 2)[0]).toMatchObject({
      from: { x: 20, y: 40 },
      to: { x: 60, y: 80 },
    });
    expect(scaleShapes(marks, 1)).toBe(marks);
    // The capture renders at least 320 wide, so a narrow page scales up into it.
    expect(captureSize({ ...page, viewport: { width: 300, height: 600, dark: false } })).toEqual({
      width: 320,
      height: 600,
    });
    expect(pageContext(page, 2)).toBe(
      'Page: OmniProbe · http://localhost:3000/reports\nViewport: 1000×700, scrolled to 0,420\nThe screenshot shows my 2 marks on the page.',
    );
  });

  it('starts the page picker, shows the picked element, and adds it with the page as it is now', async () => {
    const frame = document.createElement('iframe');
    document.body.append(frame);
    const sent: unknown[] = [];
    vi.spyOn(frame.contentWindow!, 'postMessage').mockImplementation((m: unknown) => {
      sent.push(m);
    });
    const onAdd = vi.fn();
    render(
      <PreviewMarkup frame={() => frame} onAdd={onAdd} onClose={() => {}} onError={() => {}} />,
    );
    expect(sent).toContainEqual({ pmPicker: true, type: 'start' });
    const fromPage = (data: object) =>
      act(() => {
        window.dispatchEvent(
          new MessageEvent('message', {
            data: { pmPicker: true, ...data },
            source: frame.contentWindow,
          }),
        );
      });
    // Only the shown frame counts.
    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', { data: { pmPicker: true, type: 'picked' } }),
      );
    });
    expect(screen.getByRole('button', { name: 'Add to chat' })).toHaveProperty('disabled', true);
    await fromPage({
      type: 'picked',
      element: { ...page, tag: 'h2', selector: 'main > h2', rect: {}, styles: {} },
    });
    expect(screen.getByText('<h2>')).toBeTruthy();
    // Drawing hands the pointer back from the page.
    fireEvent.click(screen.getByRole('button', { name: 'Draw' }));
    expect(sent).toContainEqual({ pmPicker: true, type: 'pause' });
    fireEvent.click(screen.getByRole('button', { name: 'Add to chat' }));
    expect(sent).toContainEqual({ pmPicker: true, type: 'state' });
    await fromPage({ type: 'state', page: { ...page, scroll: { x: 0, y: 900, inner: null } } });
    await vi.waitFor(() => expect(onAdd).toHaveBeenCalled());
    const added = onAdd.mock.calls[0]![0];
    expect(added.page.scroll.y).toBe(900);
    expect(added.element.selector).toBe('main > h2');
    expect(added.marks).toEqual([]);
  });
});

describe('the Text tool (PM-329)', () => {
  it('opens a box that keeps focus, adds the text on Enter or on clicking away, and drops it on Esc', async () => {
    const { MarkupLayer } = await import('./Markup');
    const onShapes = vi.fn();
    render(
      <MarkupLayer
        width={400}
        height={300}
        shapes={[]}
        onShapes={onShapes}
        tool="text"
        color="#ff4d4f"
        className="layer"
        label="Marks"
      />,
    );
    const canvas = screen.getByLabelText('Marks');
    canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 400, height: 300 }) as DOMRect;
    // The press must not move focus away from the box it opens.
    const press = () => fireEvent.pointerDown(canvas, { clientX: 40, clientY: 50 });
    expect(press()).toBe(false);
    const box = screen.getByLabelText('Text to add');
    expect(document.activeElement).toBe(box);
    fireEvent.change(box, { target: { value: 'too big' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(onShapes).toHaveBeenLastCalledWith([
      { kind: 'text', color: '#ff4d4f', at: { x: 40, y: 50 }, text: 'too big' },
    ]);
    // Clicking away keeps it too.
    press();
    fireEvent.change(screen.getByLabelText('Text to add'), { target: { value: 'kept' } });
    fireEvent.blur(screen.getByLabelText('Text to add'));
    expect(onShapes).toHaveBeenCalledTimes(2);
    // Esc drops it.
    press();
    fireEvent.change(screen.getByLabelText('Text to add'), { target: { value: 'gone' } });
    fireEvent.keyDown(screen.getByLabelText('Text to add'), { key: 'Escape' });
    expect(screen.queryByLabelText('Text to add')).toBeNull();
    expect(onShapes).toHaveBeenCalledTimes(2);
  });
});

describe('moving and editing text (PM-329)', () => {
  it('drags an existing text mark to a new place, and a click on it edits it in place', async () => {
    const { MarkupLayer } = await import('./Markup');
    const onShapes = vi.fn();
    const shapes = [
      { kind: 'text' as const, color: '#4c8dff', at: { x: 100, y: 100 }, text: 'Hello' },
    ];
    const { rerender } = render(
      <MarkupLayer
        width={400}
        height={300}
        shapes={shapes}
        onShapes={onShapes}
        tool="text"
        color="#ff4d4f"
        className="layer"
        label="Marks"
      />,
    );
    const canvas = screen.getByLabelText('Marks');
    canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 400, height: 300 }) as DOMRect;
    canvas.setPointerCapture = () => {};
    // A drag on the text moves it.
    fireEvent.pointerDown(canvas, { clientX: 105, clientY: 105, pointerId: 1 });
    fireEvent.pointerMove(canvas, { clientX: 165, clientY: 145, pointerId: 1 });
    fireEvent.pointerUp(canvas, { clientX: 165, clientY: 145, pointerId: 1 });
    expect(onShapes).toHaveBeenLastCalledWith([{ ...shapes[0], at: { x: 160, y: 140 } }]);
    // A click on it opens it for editing, in its own colour, and emptying it removes the mark.
    rerender(
      <MarkupLayer
        width={400}
        height={300}
        shapes={shapes}
        onShapes={onShapes}
        tool="text"
        color="#ff4d4f"
        className="layer"
        label="Marks"
      />,
    );
    fireEvent.pointerDown(canvas, { clientX: 105, clientY: 105, pointerId: 2 });
    fireEvent.pointerUp(canvas, { clientX: 105, clientY: 105, pointerId: 2 });
    const box = screen.getByLabelText('Edit the text') as HTMLInputElement;
    expect(box.value).toBe('Hello');
    expect(box.placeholder).toBe('');
    fireEvent.change(box, { target: { value: '' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(onShapes).toHaveBeenLastCalledWith([]);
  });
});
