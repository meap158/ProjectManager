import { useEffect, useRef } from 'react';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import type { AgentOutput } from '../../../shared/types';

/**
 * Read-only terminal rendering a session/run log via xterm.js (the same
 * renderer VS Code uses), so ANSI colours and cursor motion from AI CLIs
 * display faithfully. Output streams in by byte offset; the host polls while
 * the process is alive.
 */
export function TerminalView({
  fetchOutput,
  pollMs = 750,
  height = 320,
}: {
  fetchOutput: (after: number) => Promise<AgentOutput>;
  pollMs?: number;
  height?: number;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const offsetRef = useRef(0);
  const fetchRef = useRef(fetchOutput);

  // Keep the latest fetcher without re-subscribing the terminal.
  useEffect(() => {
    fetchRef.current = fetchOutput;
  });

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const term = new Terminal({
      fontFamily: "ui-monospace, 'Cascadia Code', 'SF Mono', Menlo, Consolas, monospace",
      fontSize: 12.5,
      lineHeight: 1.4,
      scrollback: 5000,
      cursorBlink: false,
      disableStdin: true,
      theme: {
        background: '#121211',
        foreground: '#f4f4f1',
        cursor: '#5598e7',
        selectionBackground: '#264f78',
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    fit.fit();
    offsetRef.current = 0;

    const resize = new ResizeObserver(() => {
      try {
        fit.fit();
      } catch {
        // Host collapsed (e.g. closed <details>): refit on reopen.
      }
    });
    resize.observe(host);
    const onWindowResize = () => {
      try {
        fit.fit();
      } catch {
        // Ignore until visible again.
      }
    };
    window.addEventListener('resize', onWindowResize);

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function poll() {
      if (cancelled) return;
      try {
        const out = await fetchRef.current(offsetRef.current);
        if (cancelled) return;
        if (out.data) {
          term.write(out.data, () => term.scrollToBottom());
        }
        offsetRef.current = out.nextOffset;
        // A finished process drains first: keep reading while bytes arrive.
        if (!out.running && !out.data) return;
        timer = setTimeout(poll, out.running ? pollMs : 250);
      } catch {
        // Transient fetch failure: keep the old output, try again.
        timer = setTimeout(poll, pollMs);
      }
    }
    poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      window.removeEventListener('resize', onWindowResize);
      resize.disconnect();
      term.dispose();
    };
  }, [pollMs]);

  return (
    <div
      ref={hostRef}
      className="terminal"
      style={{ height }}
      role="log"
      aria-label="Terminal output"
    />
  );
}
