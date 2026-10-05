// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { Link, MemoryRouter, useLocation } from 'react-router';
import { afterEach, describe, expect, it } from 'vitest';
import { RememberLastPage, readLastPage, saveLastPage, sanitizeLastPage } from './lastPage';

afterEach(() => {
  cleanup();
  localStorage.clear();
  sessionStorage.clear();
});

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="loc">{location.pathname + location.search}</output>;
}

function renderAt(path: string) {
  return render(
    <StrictMode>
      <MemoryRouter initialEntries={[path]}>
        <RememberLastPage />
        <Link to="/">All projects</Link>
        <LocationProbe />
      </MemoryRouter>
    </StrictMode>,
  );
}

describe('sanitizeLastPage', () => {
  it('keeps in-app pages and the query keys they use', () => {
    expect(sanitizeLastPage('/projects/17?tab=agents&foo=1')).toBe('/projects/17?tab=agents');
    expect(sanitizeLastPage('/board?show=planned&project=4&evil=1')).toBe(
      '/board?show=planned&project=4',
    );
    expect(sanitizeLastPage('/workspace?open=12')).toBe('/workspace?open=12');
    expect(sanitizeLastPage('/settings?x=1')).toBe('/settings');
    expect(sanitizeLastPage('/')).toBe('/');
  });

  it('rejects anything that is not an app route', () => {
    expect(sanitizeLastPage('//evil.example')).toBeNull();
    expect(sanitizeLastPage('https://evil.example/board')).toBeNull();
    expect(sanitizeLastPage('/projects/nope')).toBeNull();
    expect(sanitizeLastPage('/projects/17/edit')).toBeNull();
    expect(sanitizeLastPage('/nope')).toBeNull();
  });
});

describe('RememberLastPage', () => {
  it('returns to the last page when a visit starts on the dashboard', async () => {
    saveLastPage('/projects/17?tab=agents');
    renderAt('/');
    await waitFor(() =>
      expect(screen.getByTestId('loc').textContent).toBe('/projects/17?tab=agents'),
    );
    expect(readLastPage()).toBe('/projects/17?tab=agents');
  });

  it('does not override a page that was opened directly', async () => {
    saveLastPage('/board');
    renderAt('/projects/3?tab=board');
    await waitFor(() =>
      expect(screen.getByTestId('loc').textContent).toBe('/projects/3?tab=board'),
    );
    expect(readLastPage()).toBe('/projects/3?tab=board');
  });

  it('stays on All projects once that is chosen, including a later visit to it', async () => {
    saveLastPage('/workspace?open=8');
    renderAt('/');
    await waitFor(() => expect(screen.getByTestId('loc').textContent).toBe('/workspace?open=8'));
    fireEvent.click(screen.getByRole('link', { name: 'All projects' }));
    await waitFor(() => expect(screen.getByTestId('loc').textContent).toBe('/'));
    expect(readLastPage()).toBe('/');
  });
});
