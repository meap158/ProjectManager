// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
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
