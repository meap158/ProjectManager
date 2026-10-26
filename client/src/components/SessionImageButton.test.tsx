// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { sendImageToSession } from '../sessionImages';
import { SessionImageButton } from './SessionImageButton';

vi.mock('../sessionImages', () => ({ sendImageToSession: vi.fn() }));

it('adds all selected photos in order and continues after an individual failure', async () => {
  const send = vi.mocked(sendImageToSession);
  send
    .mockResolvedValueOnce(undefined)
    .mockRejectedValueOnce(new Error('Unsupported photo'))
    .mockResolvedValueOnce(undefined);
  const paste = vi.fn();
  const onError = vi.fn();
  const { container } = render(
    <SessionImageButton sessionId={7} pasteRef={{ current: paste }} onError={onError} />,
  );
  const input = container.querySelector('input')!;
  expect(input.multiple).toBe(true);
  const files = ['one.png', 'two.png', 'three.png'].map(
    (name) => new File(['photo'], name, { type: 'image/png' }),
  );
  fireEvent.change(input, { target: { files } });
  await waitFor(() => expect(send).toHaveBeenCalledTimes(3));
  expect(send.mock.calls.map((call) => call[1].name)).toEqual(files.map((file) => file.name));
  expect(send.mock.calls.every((call) => call[0] === 7 && call[2] === paste)).toBe(true);
  expect(onError).toHaveBeenCalledWith('two.png: Unsupported photo');
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Add images' }).hasAttribute('disabled')).toBe(false),
  );
});

it('hands the photos to the chat when it is showing, so they preview at once (PM-301)', () => {
  const send = vi.mocked(sendImageToSession);
  send.mockClear();
  const addImages = vi.fn();
  const paste = Object.assign(vi.fn(), { addImages });
  const { container } = render(
    <SessionImageButton sessionId={7} pasteRef={{ current: paste }} onError={vi.fn()} />,
  );
  const files = [new File(['photo'], 'shot.jpg', { type: 'image/jpeg' })];
  fireEvent.change(container.querySelector('input')!, { target: { files } });
  expect(addImages).toHaveBeenCalledWith(files);
  expect(send).not.toHaveBeenCalled();
  expect(
    screen.getAllByRole('button', { name: 'Add images' }).at(-1)!.hasAttribute('disabled'),
  ).toBe(false);
});
