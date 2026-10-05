import { useEffect, useRef } from 'react';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import type { AgentOutput } from '../../../shared/types';

/**
 * Terminal rendering a session/run log via xterm.js (the same renderer VS Code uses), so ANSI
 * colours and cursor motion from AI CLIs display faithfully.
 *
 * Two modes:
 *  - Read-only (runs): output is polled by byte offset while the process is alive.
 *  - Interactive (PTY sessions, `streamUrl` + `onInput`): output arrives live over server-sent
 *    events, every keystroke is forwarded (so full-screen CLIs like `claude` work), and the
 *    terminal size is reported so the remote PTY matches what you see.
 */
export function TerminalView({
  fetchOutput,
  streamUrl,
  onInput,
  onResize,
  paused = false,
  pollMs = 750,
  height = 320,
  fontSize = 12.5,
}: {
  fetchOutput: (after: number) => Promise<AgentOutput>;
  /** Builds the SSE URL resuming from a byte offset; enables live streaming. */
  streamUrl?: (after: number) => string;
  /** Receives raw keystrokes; makes the terminal interactive. */
  onInput?: (data: string) => void;
  onResize?: (cols: number, rows: number) => void;
  /** Stops all traffic but keeps the terminal, offset and scrollback (hidden tabs). */
  paused?: boolean;
  pollMs?: number;
  height?: number | string;
  /** Changes apply live (no terminal re-creation, output is kept). */
  fontSize?: number;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const offsetRef = useRef(0);
  // Keep the latest callbacks without re-creating the terminal.
  const callbacks = useRef({ fetchOutput, streamUrl, onInput, onResize, paused });
  useEffect(() => {
    callbacks.current = { fetchOutput, streamUrl, onInput, onResize, paused };
  });
  const interactive = onInput !== undefined;
  const streaming = streamUrl !== undefined;
  // The live terminal + its refit, so font size changes apply without re-creating it.
  const live = useRef<{ term: Terminal; refit: () => void; start: () => void } | null>(null);
  const initialFontSize = useRef(fontSize);
  const ctl = useRef<{
    timer?: ReturnType<typeof setTimeout>;
    source?: EventSource | null;
    polling: boolean;
  }>({ polling: false });

  // Pause/resume from the outside (hidden tab): traffic stops, everything kept.
  useEffect(() => {
    const controller = ctl.current;
    const terminal = live.current;
    if (paused) {
      if (controller.timer) clearTimeout(controller.timer);
      controller.source?.close();
      controller.source = null;
      controller.polling = false;
    } else {
      terminal?.start();
    }
  }, [paused]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const term = new Terminal({
      fontFamily: "ui-monospace, 'Cascadia Code', 'SF Mono', Menlo, Consolas, monospace",
      fontSize: initialFontSize.current,
      lineHeight: 1.25,
      scrollback: 5000,
      cursorBlink: interactive,
      disableStdin: !interactive,
      // PTY output already carries CRLF; plain pipe/run logs often have bare LF.
      convertEol: !interactive,
      theme: {
        background: '#121211',
        foreground: '#f4f4f1',
        cursor: '#5598e7',
        selectionBackground: '#264f78',
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    offsetRef.current = 0;

    // Guards every async path: React StrictMode (dev) disposes and re-creates the terminal, and
    // xterm throws if written to or resized after dispose.
    let cancelled = false;
    let lastSize = '';
    const refit = () => {
      if (cancelled) return;
      try {
        fit.fit();
      } catch {
        return; // Host collapsed (e.g. closed <details>): refit when visible again.
      }
      const size = `${term.cols}x${term.rows}`;
      if (size !== lastSize) {
        lastSize = size;
        callbacks.current.onResize?.(term.cols, term.rows);
      }
    };
    const resize = new ResizeObserver(refit);
    const inputSub = interactive ? term.onData((data) => callbacks.current.onInput?.(data)) : null;
    // Copy the controller: cleanup must not read a ref that may have changed by then.
    const controller = ctl.current;

    const stopLoop = () => {
      controller.polling = false;
    };

    const write = (data: string, nextOffset: number) => {
      if (cancelled) return;
      // Ignore anything older than what we've shown (e.g. a reconnect racing a poll).
      if (nextOffset <= offsetRef.current) return;
      offsetRef.current = nextOffset;
      term.write(data);
    };

    function connect() {
      if (cancelled || controller.polling) return;
      controller.polling = true;
      // Reconnect manually from our own offset: EventSource's built-in retry would replay the
      // original URL and duplicate output.
      const source = new EventSource(callbacks.current.streamUrl!(offsetRef.current));
      controller.source = source;
      source.addEventListener('output', (event) => {
        const { data, nextOffset } = JSON.parse((event as MessageEvent<string>).data) as {
          data: string;
          nextOffset: number;
        };
        write(data, nextOffset);
      });
      source.onerror = () => {
        source.close();
        if (controller.source === source) controller.source = null;
        stopLoop();
        controller.timer = setTimeout(() => live.current?.start(), 1000);
      };
    }

    async function poll() {
      if (cancelled || controller.polling) return;
      controller.polling = true;
      try {
        const out = await callbacks.current.fetchOutput(offsetRef.current);
        if (cancelled) return;
        if (out.data) write(out.data, out.nextOffset);
        if (callbacks.current.paused) {
          stopLoop();
          return;
        }
        // A finished process drains first: keep reading while bytes arrive.
        if (!out.running && !out.data) {
          stopLoop();
          return;
        }
        controller.timer = setTimeout(poll, out.running ? pollMs : 250);
      } catch {
        // Transient fetch failure: keep the old output, try again.
        controller.timer = setTimeout(poll, pollMs);
      }
    }

    const start = () => {
      if (cancelled || controller.polling || callbacks.current.paused) return;
      if (streaming) connect();
      else poll();
    };
    live.current = { term, refit, start };

    // Open on the next frame: xterm schedules viewport work right after open(), which throws if
    // the terminal is disposed first — exactly what StrictMode's throwaway mount does. A mount
    // that is cleaned up before this frame never opens at all.
    const openFrame = requestAnimationFrame(() => {
      if (cancelled) return;
      term.open(host);
      refit();
      resize.observe(host);
      window.addEventListener('resize', refit);
      if (interactive) term.focus();
      start();
    });

    return () => {
      live.current = null;
      cancelled = true;
      controller.polling = false;
      cancelAnimationFrame(openFrame);
      if (controller.timer) clearTimeout(controller.timer);
      controller.source?.close();
      controller.source = null;
      inputSub?.dispose();
      window.removeEventListener('resize', refit);
      resize.disconnect();
      term.dispose();
    };
  }, [pollMs, interactive, streaming]);

  useEffect(() => {
    const current = live.current;
    if (!current || current.term.options.fontSize === fontSize) return;
    current.term.options.fontSize = fontSize;
    current.refit(); // New cell size: recompute cols/rows and tell the PTY.
  }, [fontSize]);

  return (
    <div
      ref={hostRef}
      className={`terminal${interactive ? ' is-interactive' : ''}`}
      style={{ height }}
      role={interactive ? 'application' : 'log'}
      aria-label={
        interactive ? 'Interactive terminal (keystrokes go to the session)' : 'Terminal output'
      }
      onClick={() => hostRef.current?.querySelector('textarea')?.focus()}
    />
  );
}
