// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { TerminalClipboard } from './TerminalClipboard';

afterEach(cleanup);
it('accepts multiple images via native paste on HTTP without clipboard API', () => {
  HTMLDialogElement.prototype.showModal = vi.fn();
  HTMLDialogElement.prototype.close = vi.fn();
  const onImage = vi.fn();
  const onText = vi.fn();
  render(<TerminalClipboard onImage={onImage} onText={onText} disabled={false} />);
  fireEvent.click(screen.getByRole('button', { name: 'Paste image or text' }));
  const files = [
    new File(['a'], 'a.png', { type: 'image/png' }),
    new File(['b'], 'b.png', { type: 'image/png' }),
  ];
  fireEvent.paste(screen.getByRole('textbox', { name: 'Clipboard paste field', hidden: true }), {
    clipboardData: { files, items: [], getData: () => '' },
  });
  expect(onImage.mock.calls.map(([file]) => file)).toEqual(files);
  expect(onText).not.toHaveBeenCalled();
  expect(HTMLDialogElement.prototype.close).toHaveBeenCalledOnce();
});
it('handles item-only image paste and does not submit text with Enter', () => {
  HTMLDialogElement.prototype.close = vi.fn();
  const onImage = vi.fn();
  const onText = vi.fn();
  render(<TerminalClipboard onImage={onImage} onText={onText} disabled={false} />);
  const file = new File(['a'], 'a.png', { type: 'image/png' });
  const field = screen.getByRole('textbox', { name: 'Clipboard paste field', hidden: true });
  fireEvent.paste(field, {
    clipboardData: {
      files: [],
      items: [{ kind: 'file', type: 'image/png', getAsFile: () => file }],
      getData: () => '',
    },
  });
  expect(onImage).toHaveBeenCalledWith(file);
  fireEvent.paste(field, { clipboardData: { files: [], items: [], getData: () => 'continue' } });
  expect(onText).toHaveBeenCalledExactlyOnceWith('continue');
});
