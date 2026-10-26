// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, expect, it, vi } from 'vitest';
import type { LocalApp } from '../../../shared/types';
import { PreviewWorkspace } from './ProjectPreview';

const app: LocalApp = {
  port: 3000,
  pid: 42,
  name: 'node.exe',
  command: '',
  projectId: null,
  title: 'OmniProbe',
  icon: null,
  web: true,
};
vi.mock('../api', () => ({
  api: {
    localApps: vi.fn(async () => ({ apps: [app] })),
    previewLaunches: vi.fn(async () => ({ launches: [] })),
    listProjects: vi.fn(async () => []),
    savePreviewLaunches: vi.fn(),
    stopLocalApp: vi.fn(),
  },
}));
afterEach(cleanup);

it('on a phone, Apps shows the list while the page stays loaded, and Page returns to it', async () => {
  const { container } = render(
    <MemoryRouter initialEntries={['/preview']}>
      <PreviewWorkspace />
    </MemoryRouter>,
  );
  await screen.findAllByRole('button', { name: /OmniProbe/ });
  fireEvent.click(container.querySelector('.preview-row')!);
  const frame = await screen.findByTitle('Preview of localhost:3000');
  const root = container.querySelector('.project-preview')!;
  expect(root.classList.contains('has-target')).toBe(true);

  fireEvent.click(screen.getByRole('button', { name: 'Apps' }));
  expect(root.classList.contains('is-listing')).toBe(true);
  expect(root.classList.contains('has-target')).toBe(false);
  // The page was not emptied: the same frame is still there behind the list.
  expect(screen.getByTitle('Preview of localhost:3000')).toBe(frame);

  fireEvent.click(screen.getByRole('button', { name: 'Page' }));
  await waitFor(() => expect(root.classList.contains('has-target')).toBe(true));
  expect(screen.getByTitle('Preview of localhost:3000')).toBe(frame);
});
