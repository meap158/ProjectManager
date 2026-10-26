// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AgentSession } from '../../../shared/types';
import { api } from '../api';
import {
  PreviewPickDialog,
  appUrl,
  parsePicked,
  pickedContext,
  rankSessions,
} from './PreviewPickDialog';

vi.mock('../api', () => ({
  api: {
    listAllSessions: vi.fn(),
    sendSessionInput: vi.fn(async () => ({ queued: false })),
  },
}));
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
});
afterEach(cleanup);

const raw = {
  url: 'http://p3000.localhost:5180/reports?x=1',
  title: 'OmniProbe',
  tag: 'h2',
  selector: 'main > h2#title',
  html: '<h2 id="title">Largest</h2>' + 'x'.repeat(5000),
  text: 'Largest',
  role: 'heading',
  name: 'Largest',
  rect: { x: 10.4, y: 20.6, width: 300, height: 24 },
  viewport: { width: 1280, height: 800 },
  styles: { 'font-size': '24px', color: 'rgb(1, 2, 3)', 'BAD KEY': 'x' },
  react: {
    component: 'SectionTitle',
    props: { level: 2, onClick: undefined },
    owners: ['AtlasPage'],
  },
};

const session = (id: number, projectId: number, patch: Partial<AgentSession> = {}) =>
  ({
    id,
    projectId,
    name: `s${id}`,
    status: 'running',
    terminal: 'pty',
    orchestratorId: null,
    lastInputAt: null,
    ...patch,
  }) as AgentSession;

describe('the picked element (PM-311)', () => {
  it('keeps known fields only, capped, and refuses what is not an element', () => {
    const el = parsePicked(raw)!;
    expect(el.html.length).toBeLessThanOrEqual(2100);
    expect(el.rect).toEqual({ x: 10, y: 21, width: 300, height: 24 });
    expect(el.styles).toEqual({ 'font-size': '24px', color: 'rgb(1, 2, 3)' });
    expect(el.react).toEqual({
      component: 'SectionTitle',
      props: { level: 2 },
      owners: ['AtlasPage'],
    });
    expect(parsePicked({ ...raw, tag: '<img onerror=x>' })).toBeNull();
    expect(parsePicked('nope')).toBeNull();
  });

  it("names the app's own address, not the proxy's", () => {
    expect(appUrl('http://p3000.localhost:5180/a?b=1')).toBe('http://localhost:3000/a?b=1');
    expect(appUrl('http://192.168.1.5:5180/api/preview/5173/docs')).toBe(
      'http://localhost:5173/docs',
    );
    expect(appUrl('https://example.com/')).toBe('https://example.com/');
    const text = pickedContext(parsePicked(raw)!);
    expect(text).toContain('Page: OmniProbe — http://localhost:3000/reports?x=1');
    expect(text).toContain('React component: SectionTitle (inside AtlasPage)');
    expect(text).toContain('Accessibility: heading, "Largest"');
  });

  it("lists running sessions, the app's project first, then the most recently messaged", () => {
    const ranked = rankSessions(
      [
        session(1, 2, { lastInputAt: '2026-10-27T03:00:00Z' }),
        session(2, 7, { lastInputAt: '2026-10-26T01:00:00Z' }),
        session(3, 7, { lastInputAt: '2026-10-27T01:00:00Z' }),
        session(4, 7, { status: 'exited' }),
        session(5, 7, { orchestratorId: 'o' }),
      ],
      7,
    );
    expect(ranked.map((s) => s.id)).toEqual([3, 2, 1]);
  });

  it('sends the request and the context as one paste, then Enter, without clearing the input', async () => {
    vi.mocked(api.listAllSessions).mockResolvedValue([session(3, 7, { name: 'Builder' })]);
    render(
      <PreviewPickDialog
        element={parsePicked(raw)!}
        projectId={7}
        projectNames={new Map([[7, 'OmniProbe']])}
        onClose={() => {}}
      />,
    );
    // The app's own dropdown, defaulting to the app's project's most recent session.
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Session/ }).textContent).toContain('Builder'),
    );
    fireEvent.change(screen.getByLabelText('What should change?'), {
      target: { value: 'Make it smaller on phones' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(api.sendSessionInput).toHaveBeenCalledTimes(2));
    const [paste, enter] = vi.mocked(api.sendSessionInput).mock.calls.map((c) => c[1]);
    expect(paste!.startsWith('\x1b[200~Make it smaller on phones\n\nAbout this element')).toBe(
      true,
    );
    expect(paste).toContain('Page: OmniProbe — http://localhost:3000/reports?x=1');
    expect(paste!.endsWith('\x1b[201~')).toBe(true);
    expect(enter).toBe('\r');
    expect(await screen.findByText('Sent to Builder.')).toBeTruthy();
  });
});
