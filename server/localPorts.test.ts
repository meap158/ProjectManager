import { describe, expect, it } from 'vitest';
import {
  candidates,
  inlineIcon,
  isImageResponse,
  looksLikePage,
  parseLsof,
  parseNetstat,
  projectForCommand,
  readPageMeta,
} from './localPorts.js';

// Detecting which apps listen on this computer's loopback (PM-253).

describe('parseNetstat', () => {
  it('keeps listeners reachable through 127.0.0.1 and drops the rest', () => {
    const out = [
      '  Proto  Local Address          Foreign Address        State           PID',
      '  TCP    0.0.0.0:3001           0.0.0.0:0              LISTENING       32348',
      '  TCP    127.0.0.1:5173         0.0.0.0:0              LISTENING       100',
      '  TCP    [::1]:8080             [::]:0                 LISTENING       200',
      '  TCP    [::]:3001              [::]:0                 LISTENING       32348',
      '  TCP    192.168.1.5:9000       0.0.0.0:0              LISTENING       300',
      '  TCP    127.0.0.1:5173         127.0.0.1:50000        ESTABLISHED     100',
      '  UDP    0.0.0.0:5353           *:*                                    400',
    ].join('\r\n');
    expect(parseNetstat(out)).toEqual([
      { port: 3001, pid: 32348, host: '[::]' },
      { port: 5173, pid: 100, host: '127.0.0.1' },
      { port: 8080, pid: 200, host: '[::1]' },
    ]);
  });
});

describe('parseLsof', () => {
  it('reads pid and name lines', () => {
    const out = 'p100\nn127.0.0.1:5173\np200\nn*:3000\nn[::1]:8080\np300\nn10.0.0.2:9000\n';
    expect(parseLsof(out)).toEqual([
      { port: 5173, pid: 100, host: '127.0.0.1' },
      { port: 3000, pid: 200, host: '*' },
      { port: 8080, pid: 200, host: '[::1]' },
    ]);
  });
});

describe('candidates', () => {
  it('drops privileged, ephemeral and own ports, and sorts', () => {
    const list = [
      { port: 49664, pid: 1 },
      { port: 445, pid: 4 },
      { port: 5180, pid: 5 },
      { port: 8080, pid: 6 },
      { port: 3000, pid: 7 },
    ];
    expect(candidates(list, new Set([5180]))).toEqual([
      { port: 3000, pid: 7 },
      { port: 8080, pid: 6 },
    ]);
  });
});

describe('projectForCommand', () => {
  const projects = [
    { id: 1, path: 'S:\\Vibe Coding\\Alpha' },
    { id: 2, path: 'S:\\Vibe Coding\\Alpha\\apps\\web' },
  ];
  it('matches across slash styles and case, longest folder first', () => {
    expect(projectForCommand('node "s:/vibe coding/alpha/server.js"', projects)).toBe(1);
    expect(projectForCommand('node S:\\Vibe Coding\\Alpha\\apps\\web\\dev.js', projects)).toBe(2);
  });
  it('leaves unrelated commands unattributed', () => {
    expect(projectForCommand('node C:\\tools\\other.js', projects)).toBeNull();
    expect(projectForCommand('', projects)).toBeNull();
  });
});

describe('readPageMeta', () => {
  it('reads the title and the declared icon', () => {
    const html =
      '<html><head><title> My  App\n</title><link rel="stylesheet" href="/a.css">' +
      '<link rel="shortcut icon" href="/static/logo.svg"></head>';
    expect(readPageMeta(html, 3000)).toEqual({ title: 'My App', icon: '/static/logo.svg' });
  });
  it('falls back to /favicon.ico and resolves relative or same-port icons', () => {
    expect(readPageMeta('<title>x</title>', 3000)).toEqual({ title: 'x', icon: '/favicon.ico' });
    expect(readPageMeta('<link rel="icon" href="img/i.png">', 3000).icon).toBe('/img/i.png');
    expect(readPageMeta('<link rel="icon" href="http://localhost:3000/i.png">', 3000).icon).toBe(
      '/i.png',
    );
  });
  it('never points the icon at another host', () => {
    expect(readPageMeta('<link rel="icon" href="https://evil.example/i.png">', 3000).icon).toBe(
      '/favicon.ico',
    );
    expect(readPageMeta('<link rel="icon" href="//evil.example/i.png">', 3000).icon).toBe(
      '/favicon.ico',
    );
  });
});

describe('candidates', () => {
  it('lists one app for a port two programs share: the one 127.0.0.1 reaches', () => {
    const found = candidates(
      [
        { port: 3000, pid: 10, host: '0.0.0.0' },
        { port: 3000, pid: 11, host: '[::]' },
        { port: 3000, pid: 12, host: '127.0.0.1' },
        { port: 4000, pid: 13, host: '0.0.0.0' },
      ],
      new Set(),
    );
    expect(found.map((l) => [l.port, l.pid])).toEqual([
      [3000, 12],
      [4000, 13],
    ]);
  });
  it('keeps every listener when none is bound to 127.0.0.1', () => {
    const found = candidates(
      [
        { port: 3000, pid: 10, host: '0.0.0.0' },
        { port: 3000, pid: 11, host: '[::]' },
      ],
      new Set(),
    );
    expect(found).toHaveLength(2);
  });
});

describe('looksLikePage', () => {
  it('tells a page from the empty or plain-text HTML a back end answers with', () => {
    expect(looksLikePage('<!doctype html><div id="root"></div>')).toBe(true);
    expect(looksLikePage('<title>x</title>')).toBe(true);
    expect(looksLikePage('')).toBe(false);
    expect(looksLikePage('OK')).toBe(false);
  });
});

describe('inline icons', () => {
  // FrameMotion's real head: a multi-line <link> whose data: URL has `>` and single quotes in it.
  const svg =
    "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><rect width='32' height='32' rx='8' fill='%230B0F1A'/></svg>";
  const html = `<head><title>FrameMotion Console</title>\n<link\n  rel="icon"\n  href="${svg}"\n/>\n<script src="/a.js"></script></head>`;
  it('uses a small embedded image as the icon', () => {
    expect(readPageMeta(html, 4400)).toEqual({ title: 'FrameMotion Console', icon: svg });
  });
  it('only accepts plain, small images', () => {
    expect(inlineIcon('data:text/html,<script>1</script>')).toBeNull();
    expect(inlineIcon('data:image/svg+xml,' + 'x'.repeat(40_000))).toBeNull();
    expect(inlineIcon('/favicon.ico')).toBeNull();
    expect(inlineIcon('data:image/png;base64,AAAA')).toBe('data:image/png;base64,AAAA');
  });
});

describe('isImageResponse', () => {
  it('accepts a real icon', () => {
    expect(isImageResponse(200, 'image/svg+xml')).toBe(true);
    expect(isImageResponse(200, 'image/x-icon')).toBe(true);
    expect(isImageResponse(200, 'image/png; charset=binary')).toBe(true);
  });
  it('refuses the HTML page a single-page app answers every path with, and errors', () => {
    expect(isImageResponse(200, 'text/html; charset=utf-8')).toBe(false);
    expect(isImageResponse(404, 'image/png')).toBe(false);
    expect(isImageResponse(200, null)).toBe(false);
  });
});
