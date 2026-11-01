// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { fitImage, ImageViewer } from './ImageViewer';
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it('fits tall, wide, small and rotated images inside the usable stage', () => {
  expect(fitImage({ w: 1227, h: 1282 }, { w: 1776, h: 743 })).toMatchObject({ h: 743 });
  const portrait = fitImage({ w: 1227, h: 1282 }, { w: 374, h: 668 });
  expect(portrait.w).toBe(374);
  expect(portrait.h).toBeLessThan(668);
  expect(fitImage({ w: 2000, h: 500 }, { w: 300, h: 500 })).toEqual({ w: 300, h: 75, ratio: 0.15 });
  expect(fitImage({ w: 100, h: 50 }, { w: 300, h: 500 })).toEqual({ w: 100, h: 50, ratio: 1 });
  expect(fitImage({ w: 1227, h: 1282 }, { w: 828, h: 214 }).h).toBeCloseTo(214);
});
it('opens fitted, reports pixel scale, supports actual size and returns to Fit', () => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1000);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(800);
  render(
    <ImageViewer
      items={[
        {
          name: 'tall.png',
          path: 'tall.png',
          kind: 'file',
          size: 10,
          mtime: null,
          ctime: null,
          ignored: false,
          symlink: false,
          width: 1227,
          height: 1282,
          git: null,
        },
      ]}
      index={0}
      rawUrl={() => 'image.png'}
      onIndex={() => {}}
      onClose={() => {}}
    />,
  );
  const image = screen.getByAltText('tall.png') as HTMLImageElement;
  Object.defineProperties(image, { naturalWidth: { value: 1227 }, naturalHeight: { value: 1282 } });
  fireEvent.load(image);
  const stage = document.querySelector('.iv-stage')!;
  const css = getComputedStyle(stage);
  const height = 800 - parseFloat(css.paddingTop) - parseFloat(css.paddingBottom);
  expect(parseFloat(image.style.height)).toBe(height);
  expect(parseFloat(image.style.width)).toBeLessThan(1000);
  fireEvent.click(screen.getByText('100%'));
  expect(image.style.transform).not.toContain('scale(1)');
  expect(screen.getByRole('status').textContent).toContain('100%');
  fireEvent.click(screen.getByText('Fit'));
  expect(image.style.transform).toContain('scale(1)');
  expect(parseFloat(image.style.height)).toBe(height);
});

it('bounds filmstrip rendering for large project collections without losing the current index', () => {
  const items = Array.from({ length: 18000 }, (_, i) => ({
    name: `photo-${i}.png`,
    path: `photo-${i}.png`,
    kind: 'file' as const,
    size: 10,
    mtime: null,
    ctime: null,
    ignored: false,
    symlink: false,
    width: 10,
    height: 10,
    git: null,
  }));
  const change = vi.fn();
  render(
    <ImageViewer
      items={items}
      index={9000}
      rawUrl={(p) => p}
      onIndex={change}
      onClose={() => {}}
    />,
  );
  expect(screen.getAllByRole('option')).toHaveLength(41);
  expect(screen.getByRole('option', { name: 'photo-9000.png' }).getAttribute('aria-selected')).toBe(
    'true',
  );
  fireEvent.click(screen.getByRole('option', { name: 'photo-9001.png' }));
  expect(change).toHaveBeenCalledWith(9001);
  fireEvent.keyDown(screen.getByRole('dialog'), { key: 'ArrowRight' });
  expect(change).toHaveBeenCalledWith(9001);
});

it('keeps the selected thumbnail centered through arrow navigation, wrapping and resize', () => {
  let resize: (() => void) | undefined;
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(private callback: () => void) {}
      observe(element: HTMLElement) {
        if (element.classList.contains('iv-strip')) resize = this.callback;
      }
      disconnect() {}
    },
  );
  let width = 300;
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement,
  ) {
    const bar = this.closest('.iv-strip') as HTMLElement | null;
    if (this.classList.contains('iv-strip')) return { left: 500, width } as DOMRect;
    if (bar) {
      const at = Array.from(bar.children).indexOf(this);
      return { left: 506 + at * 62 - bar.scrollLeft, width: 56 } as DOMRect;
    }
    return { left: 0, width: 1000, height: 800 } as DOMRect;
  });
  const items = Array.from({ length: 18000 }, (_, i) => ({
    name: `image-${i}.png`,
    path: `image-${i}.png`,
    kind: 'file' as const,
    size: 10,
    mtime: null,
    ctime: null,
    ignored: false,
    symlink: false,
    width: 10,
    height: 10,
    git: null,
  }));
  let select!: (index: number) => void;
  function Viewer() {
    const [index, setIndex] = useState(9000);
    select = setIndex;
    return (
      <ImageViewer
        items={items}
        index={index}
        rawUrl={(p) => p}
        onIndex={setIndex}
        onClose={() => {}}
      />
    );
  }
  render(<Viewer />);
  const bar = screen.getByRole('listbox');
  const verify = (index: number) => {
    const selected = screen.getByRole('option', { selected: true });
    expect(selected.getAttribute('aria-label')).toBe(`image-${index}.png`);
    expect(selected.getAttribute('aria-posinset')).toBe(String(index + 1));
    expect(screen.getAllByRole('option')).toHaveLength(41);
    const bounds = selected.getBoundingClientRect();
    expect(bounds.left).toBeGreaterThanOrEqual(500);
    expect(bounds.left + bounds.width).toBeLessThanOrEqual(500 + width);
    expect(document.querySelector('.iv-image')?.getAttribute('src')).toBe(`image-${index}.png`);
  };
  verify(9000);
  for (let index = 9001; index <= 9045; index++) {
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'ArrowRight' });
    verify(index);
  }
  fireEvent.keyDown(screen.getByRole('dialog'), { key: 'ArrowLeft' });
  verify(9044);
  width = 120;
  act(() => resize?.());
  verify(9044);
  expect(bar.scrollLeft).toBeGreaterThan(0);
  fireEvent.click(screen.getByRole('option', { name: 'image-9045.png' }));
  verify(9045);
  act(() => select(17999));
  verify(17999);
  fireEvent.keyDown(screen.getByRole('dialog'), { key: 'ArrowRight' });
  verify(0);
  fireEvent.keyDown(screen.getByRole('dialog'), { key: 'ArrowLeft' });
  verify(17999);
});
