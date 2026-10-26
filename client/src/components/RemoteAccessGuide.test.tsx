// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeAll, expect, it } from 'vitest';
import { RemoteAccessGuide } from './RemoteAccessGuide';

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
});
afterEach(cleanup);

it('explains where every Cloudflare field comes from, with links that open safely (PM-327)', () => {
  render(<RemoteAccessGuide port={5380} />);
  fireEvent.click(screen.getByRole('button', { name: 'Where each Cloudflare detail comes from' }));
  const guide = screen.getByRole('dialog', { name: 'Getting the Cloudflare details' });
  for (const field of ['Team name', 'Public hostname', 'Application AUD tag', 'Allowed emails'])
    expect(within(guide).getByText(field)).toBeTruthy();
  expect(guide.textContent).toContain('http://127.0.0.1:5380');
  const links = within(guide).getAllByRole('link');
  expect(links.length).toBeGreaterThanOrEqual(6);
  for (const link of links) {
    expect(link.getAttribute('href')).toMatch(
      /^https:\/\/(one\.dash|developers)\.cloudflare\.com\//,
    );
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
  }
});
