import { describe, expect, it } from 'vitest';
import {
  candidates,
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
      { port: 3001, pid: 32348 },
      { port: 5173, pid: 100 },
      { port: 8080, pid: 200 },
    ]);
  });
});

describe('parseLsof', () => {
  it('reads pid and name lines', () => {
    const out = 'p100\nn127.0.0.1:5173\np200\nn*:3000\nn[::1]:8080\np300\nn10.0.0.2:9000\n';
    expect(parseLsof(out)).toEqual([
      { port: 5173, pid: 100 },
      { port: 3000, pid: 200 },
      { port: 8080, pid: 200 },
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
