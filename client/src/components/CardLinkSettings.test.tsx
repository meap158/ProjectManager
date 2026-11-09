// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { api } from '../api';
import { CardLinkSettings } from './CardLinkSettings';
vi.mock('../api', () => ({
  api: {
    cardLinking: vi.fn(async () => ({ writeBack: false, authorized: false })),
    setCardLinking: vi.fn(async (_id: number, writeBack: boolean) => ({ writeBack })),
  },
}));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
it('starts unchecked and requires an explicit project-scoped save', async () => {
  render(<CardLinkSettings projectId={14} />);
  const input = screen.getByRole('checkbox') as HTMLInputElement;
  await waitFor(() => expect(input.disabled).toBe(false));
  expect(input.checked).toBe(false);
  expect(api.setCardLinking).not.toHaveBeenCalled();
  fireEvent.click(input);
  await waitFor(() => expect(input.checked).toBe(true));
  expect(api.setCardLinking).toHaveBeenCalledWith(14, true);
});
it('keeps the prior setting and displays a save error', async () => {
  vi.mocked(api.setCardLinking).mockRejectedValueOnce(Error('offline'));
  render(<CardLinkSettings projectId={14} />);
  const input = screen.getByRole('checkbox') as HTMLInputElement;
  await waitFor(() => expect(input.disabled).toBe(false));
  fireEvent.click(input);
  expect(await screen.findByRole('alert')).toBeTruthy();
  expect(input.checked).toBe(false);
});
