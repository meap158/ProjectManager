import { useEffect, useRef, useState, type MutableRefObject } from 'react';
import { createPortal } from 'react-dom';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import type { AgentOutput } from '../../../shared/types';

/**
 * Max history bytes to replay on initial mount. 512 KB covers ~5,000 lines of scrollback (xterm's max limit).
 * Sessions with 10–33 MB logs replay the latest 512 KB tail, eliminating multi-second freezes on load.
 */
export const MAX_INITIAL_HISTORY_BYTES = 512 * 1024;

/** Browsers cap live WebGL contexts (about 16 in Chrome) and drop the oldest past that. */
const MAX_WEBGL_TERMINALS = 6;
let webglTerminals = 0;
let hardwareWebgl: boolean | null = null;

/** False without WebGL or on a software renderer, where the DOM renderer is the faster one. */
function hasHardwareWebgl(): boolean {
  if (hardwareWebgl !== null) return hardwareWebgl;
  hardwareWebgl = false;
  try {
    const gl = document.createElement('canvas').getContext('webgl2');
    if (gl) {
      const info = gl.getExtension('WEBGL_debug_renderer_info');
      const renderer = info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : '';
      hardwareWebgl = !/swiftshader|llvmpipe|software|basic render/i.test(renderer);
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    }
  } catch {
    // Unsupported: the DOM renderer is used.
  }
  return hardwareWebgl;
}

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
  height = 480,
  fontSize = 12.5,
  historyBytes = 0,
  stopped = false,
  pasteRef,
  onImage,
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
  /**
   * Log bytes that already existed when this view mounted. Replaying them makes xterm answer
   * the old terminal queries inside; those answers are dropped instead of sent as input, where
   * they would reach the CLI as junk (or pile up in a stopped session's input queue).
   */
  historyBytes?: number;
  /** Preserve recorded geometry: a stopped full-screen CLI cannot redraw after a resize. */
  stopped?: boolean;
  /**
   * Filled with a function that pastes text the way the keyboard would (xterm's paste: bracketed
   * when the CLI asked for it), e.g. the path of an image sent from a phone (PM-54).
   */
  pasteRef?: MutableRefObject<((text: string) => void) | null>;
  /** An image file pasted or dropped onto the terminal (sent as a file, not the OS clipboard). */
  onImage?: (file: File) => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [connection, setConnection] = useState<'loading' | 'ready' | 'empty' | 'reconnecting'>(
    historyBytes > 0 ? 'loading' : 'empty',
  );
  // True once the CLI screen has been shown. Reconnects after that stay in the corner.
  const [cliShown, setCliShown] = useState(false);

  const [extraKeys, setExtraKeys] = useState(false);

  const [keyboardOpen, setKeyboardOpen] = useState(false);
  const keysRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const strip = keysRef.current?.querySelector<HTMLElement>('.terminal-key-scroll');
    const firstFunction = strip?.querySelector<HTMLElement>('[aria-label="Function 1"]');
    if (strip)
      strip.scrollLeft =
        extraKeys && firstFunction ? firstFunction.offsetLeft - strip.offsetLeft : 0;
  }, [extraKeys]);
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    let restingHeight = Math.max(viewport.height, window.innerHeight);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let frame = 0;
    let open = false;
    let pinned = false;
    // Phone typing (PM-111): while the on-screen keyboard is up, the terminal is pinned to the
    // visible area, from its top down to our key bar, like native terminal apps. Its bottom
    // edge, where CLIs draw their input line, then always sits directly above the keyboard,
    // and xterm refits its rows to the space (the CLI redraws for it). Scrolling the page to
    // bring the terminal into view (PM-79) fought iOS, which scrolls to the focused field on its
    // own, so the input line landed somewhere different every time.
    const pin = () => {
      const host = hostRef.current;
      if (!host) return;
      if (!open) {
        if (pinned) {
          for (const prop of [
            'position',
            'left',
            'top',
            'width',
            'height',
            'zIndex',
            'borderRadius',
          ])
            host.style.removeProperty(prop.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`));
          host.classList.remove('is-pinned');
          pinned = false;
        }
        return;
      }
      const bar = keysRef.current?.offsetHeight ?? 0;
      Object.assign(host.style, {
        position: 'fixed',
        left: `${viewport.offsetLeft}px`,
        top: `${viewport.offsetTop}px`,
        width: `${viewport.width}px`,
        height: `${Math.max(120, viewport.height - bar)}px`,
        zIndex: '99', // Under the key bar (1100).
        borderRadius: '0',
      });
      host.classList.add('is-pinned');
      pinned = true;
    };
    // Only touch devices have an on-screen keyboard. On desktop a window that got shorter (an
    // un-maximize, DevTools) read as one and scrolled the page and terminal on every resize.
    const touch = window.matchMedia?.('(pointer: coarse)').matches ?? false;
    const update = () => {
      const focused = hostRef.current?.contains(document.activeElement) ?? false;
      // Browser chrome can resize the viewport too; a keyboard takes substantially more space.
      restingHeight = Math.max(restingHeight, viewport.height, window.innerHeight);
      const wasOpen = open;
      open = touch && focused && restingHeight - viewport.height > 80;
      if (keysRef.current) {
        keysRef.current.style.top = `${viewport.offsetTop + viewport.height}px`;
        keysRef.current.style.left = `${viewport.offsetLeft}px`;
        keysRef.current.style.width = `${viewport.width}px`;
      }
      setKeyboardOpen(open);
      // While typing, the page hides chrome that only takes space (the phone tab bar).
      document.documentElement.toggleAttribute('data-terminal-typing', open);
      if (!open) setExtraKeys(false);
      pin();
      // The key bar appears with the keyboard: pin again once it has its height.
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(pin);
      if (open && !wasOpen) {
        const vp = hostRef.current?.querySelector<HTMLElement>('.xterm-viewport');
        if (vp) vp.scrollTop = vp.scrollHeight;
      }
    };
    const focusChanged = () => {
      clearTimeout(timer);
      timer = setTimeout(update, 0);
    };
    const resizeViewport = () => update();
    viewport.addEventListener('resize', resizeViewport);
    viewport.addEventListener('scroll', resizeViewport);
    window.addEventListener('resize', resizeViewport);
    document.addEventListener('focusin', focusChanged);
    document.addEventListener('focusout', focusChanged);
    update();
    return () => {
      clearTimeout(timer);
      cancelAnimationFrame(frame);
      open = false;
      pin();
      document.documentElement.removeAttribute('data-terminal-typing');
      viewport.removeEventListener('resize', resizeViewport);
      viewport.removeEventListener('scroll', resizeViewport);
      window.removeEventListener('resize', resizeViewport);
      document.removeEventListener('focusin', focusChanged);
      document.removeEventListener('focusout', focusChanged);
    };
  }, []);
  const offsetRef = useRef(0);
  const historyRef = useRef(historyBytes);
  // > 0 while xterm parses replayed history; anything it emits meanwhile is an automatic reply.
  const replaying = useRef(0);
  // Keep the latest callbacks without re-creating the terminal.
  const callbacks = useRef({
    fetchOutput,
    streamUrl,
    onInput,
    onResize,
    paused,
    onImage,
    pasteRef,
  });
  useEffect(() => {
    callbacks.current = { fetchOutput, streamUrl, onInput, onResize, paused, onImage, pasteRef };
  });
  const interactive = onInput !== undefined;
  const streaming = streamUrl !== undefined;
  // The live terminal + its refit, so font size changes apply without re-creating it.
  const live = useRef<{
    term: Terminal;
    refit: () => void;
    start: () => void;
    retry: () => void;
  } | null>(null);
  const initialFontSize = useRef(fontSize);
  const sendKey = (data: string) => {
    if (callbacks.current.paused) return;
    live.current?.term.scrollToBottom();
    // Full-screen applications can request the alternate cursor-key sequences.
    const application = live.current?.term.modes?.applicationCursorKeysMode;
    callbacks.current.onInput?.(
      application && data.startsWith('\x1b[') && data.length === 3 && 'ABCDHF'.includes(data[2]!)
        ? data.replace('\x1b[', '\x1bO')
        : data,
    );
  };
  const ctl = useRef<{
    timer?: ReturnType<typeof setTimeout>;
    source?: EventSource | null;
    polling: boolean;
  }>({ polling: false });

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const term = new Terminal({
      fontFamily: "ui-monospace, 'Cascadia Code', 'SF Mono', Menlo, Consolas, monospace",
      fontSize: initialFontSize.current,
      lineHeight: 1.25,
      scrollback: 5000,
      smoothScrollDuration: 0,
      cursorBlink: interactive,
      disableStdin: !interactive,
      // PTY output already carries CRLF; plain pipe/run logs often have bare LF.
      convertEol: !interactive,
      windowsPty: {
        backend: 'conpty',
        buildNumber: 22631,
      },
      theme: {
        background: '#121211',
        foreground: '#f4f4f1',
        cursor: '#5598e7',
        selectionBackground: '#264f78',
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    const totalHistory = historyRef.current;
    const initialOffset =
      totalHistory > MAX_INITIAL_HISTORY_BYTES ? totalHistory - MAX_INITIAL_HISTORY_BYTES : 0;
    offsetRef.current = initialOffset;
    replaying.current = 0;
    const restoreBytes = totalHistory;
    let restoring = restoreBytes > initialOffset;
    const scrollDuration = term.options.smoothScrollDuration;
    let revealFrame: number | null = null;
    let stickFrame: number | null = null;
    let recoveryTimer: ReturnType<typeof setTimeout> | undefined;
    let receivedOutput = false;
    let serverResponded = false;
    if (restoring) {
      // Keep layout measurable, but don't paint intermediate historical screens.
      host.style.visibility = 'hidden';
      host.setAttribute('aria-busy', 'true');
      term.options.smoothScrollDuration = 0;
    }

    // Guards every async path: React StrictMode (dev) disposes and re-creates the terminal, and
    // xterm throws if written to or resized after dispose.
    let cancelled = false;
    let opened = false;
    const markConnection = (next: 'ready' | 'empty' | 'reconnecting') => {
      if (next === 'ready') setCliShown(true);
      setConnection(next);
    };
    const reveal = () => {
      if (cancelled || !restoring || revealFrame !== null) return;
      term.scrollToBottom();
      revealFrame = requestAnimationFrame(() => {
        revealFrame = null;
        if (cancelled) return;
        restoring = false;
        clearTimeout(recoveryTimer);
        host.style.visibility = '';
        host.removeAttribute('aria-busy');
        term.options.smoothScrollDuration = scrollDuration;
        term.refresh(0, term.rows - 1);
        markConnection(receivedOutput ? 'ready' : 'empty');
        if (interactive && !callbacks.current.paused) term.focus();
      });
    };
    // A drain notification is authoritative even when the initial byte-count snapshot is stale.
    // An empty write runs after queued xterm writes, so no partial historical frame is revealed.
    const revealDrained = () => {
      if (cancelled) return;
      const drainedThrough = offsetRef.current;
      term.write('', () => {
        if (cancelled) return;
        if (restoring) historyRef.current = drainedThrough;
        if (restoring) reveal();
        else markConnection(receivedOutput ? 'ready' : 'empty');
      });
    };
    let lastSize = '';
    const geometry = term.parser.registerOscHandler(777, (data) => {
      const match = /^pm-size;(\d+);(\d+)$/.exec(data);
      if (!match) return false;
      const cols = Number(match[1]);
      const rows = Number(match[2]);
      if (stopped && cols >= 20 && cols <= 500 && rows >= 1 && rows <= 500) {
        term.resize(cols, rows);
      }
      return true;
    });
    let touchY: number | null = null;
    let touchX = 0;
    let touchRemainder = 0;
    let scrollFrame: number | null = null;
    let velocity = 0;
    let lastMove = 0;
    let momentumFrame: number | null = null;
    let pixelTarget: number | null = null;
    let lastInputTime = 0;
    let lastTouchScrollTime = 0;
    const viewport = () => host.querySelector<HTMLElement>('.xterm-viewport');
    // Follow new output only while the reader is at the bottom (PM-96). Scrolling up (wheel,
    // swipe, scrollbar, keys) stops following; scrolling back to the bottom or typing resumes it.
    // Focus alone never moves the view: on desktop the terminal is focused nearly all the time,
    // and busy CLIs redraw constantly, so following focus made scrolling back impossible.
    let following = true;
    let lastGesture = 0;
    const atBottom = (element: HTMLElement) =>
      element.scrollTop >= element.scrollHeight - element.clientHeight - 4;

    const scrollToBottomAndSync = () => {
      following = true;
      term.scrollToBottom();
      const element = viewport();
      if (element) {
        pixelTarget = Math.max(0, element.scrollHeight - element.clientHeight);
      }
    };

    const refit = () => {
      if (cancelled || !opened) return;
      if (stopped) return;
      const wasAtBottom = following || Date.now() - lastInputTime < 5000;
      try {
        fit.fit();
      } catch {
        return; // Host collapsed (e.g. closed <details>): refit when visible again.
      }
      if (!restoring && wasAtBottom && interactive) {
        scrollToBottomAndSync();
      }
      const size = `${term.cols}x${term.rows}`;
      if (size !== lastSize) {
        lastSize = size;
        callbacks.current.onResize?.(term.cols, term.rows);
      }
    };
    // Mobile keyboard animation emits many transient sizes. Fit after it settles so the PTY
    // receives one geometry update instead of repeatedly clearing and redrawing its screen.
    let resizeTimer: ReturnType<typeof setTimeout> | undefined;
    const scheduleRefit = () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(refit, window.matchMedia('(pointer: coarse)').matches ? 120 : 16);
    };
    const resize = new ResizeObserver(scheduleRefit);
    const inputSub = interactive
      ? term.onData((data) => {
          lastInputTime = Date.now();
          scrollToBottomAndSync();
          if (replaying.current === 0) callbacks.current.onInput?.(data);
        })
      : null;
    // Ctrl+V pastes text like any app (xterm would otherwise send a raw ^V control character, so
    // only Ctrl+Shift+V worked). Returning false leaves the keystroke to the browser, whose paste
    // event xterm handles (with bracketed paste). If the clipboard holds no text (e.g. only an
    // image), ^V is still sent: CLIs like OpenCode read image pastes from the clipboard themselves.
    let pasteViaBrowser = false;
    if (interactive) {
      term.attachCustomKeyEventHandler((e) => {
        if (
          e.type === 'keydown' &&
          (e.ctrlKey || e.metaKey) &&
          !e.shiftKey &&
          !e.altKey &&
          (e.key === 'ArrowDown' || e.key === 'ArrowUp')
        ) {
          return false;
        }
        if (
          e.type === 'keydown' &&
          e.ctrlKey &&
          !e.shiftKey &&
          !e.altKey &&
          !e.metaKey &&
          e.key.toLowerCase() === 'v'
        ) {
          pasteViaBrowser = true;
          // No paste event (empty clipboard / non-text only): fall back to ^V for the CLI.
          setTimeout(() => {
            if (pasteViaBrowser && replaying.current === 0) callbacks.current.onInput?.('\x16');
            pasteViaBrowser = false;
          }, 50);
          return false;
        }
        return true;
      });
    }
    /** The first image file in a paste or drop, when someone takes images. */
    const imageOf = (data: DataTransfer | null) =>
      callbacks.current.onImage
        ? ([...(data?.files ?? [])].find((f) => f.type.startsWith('image/')) ??
          Array.from(data?.items ?? [])
            .find((item) => item.kind === 'file' && item.type.startsWith('image/'))
            ?.getAsFile() ??
          null)
        : null;
    const onPaste = (event: ClipboardEvent) => {
      const text = event.clipboardData?.getData('text/plain') ?? '';
      const image = imageOf(event.clipboardData);
      if (image) {
        // An image (screenshot, copied photo): sent as a file whose path is pasted in, so it
        // works from a phone and for every CLI, not only those reading the OS clipboard.
        pasteViaBrowser = false;
        event.preventDefault();
        event.stopPropagation();
        callbacks.current.onImage?.(image);
        return;
      }
      // Text: xterm's own paste handling takes it from here. No text: keep the ^V fallback.
      if (text) pasteViaBrowser = false;
    };
    host.addEventListener('paste', onPaste, true);
    const onDragOver = (event: DragEvent) => {
      if (callbacks.current.onImage && event.dataTransfer?.types.includes('Files')) {
        event.preventDefault();
      }
    };
    const onDrop = (event: DragEvent) => {
      const image = imageOf(event.dataTransfer);
      if (!image) return;
      event.preventDefault();
      callbacks.current.onImage?.(image);
    };
    host.addEventListener('dragover', onDragOver);
    host.addEventListener('drop', onDrop);
    // Capture owns touch scrolling so xterm's built-in handler cannot process it twice.
    const rowHeight = () => (term.options.fontSize ?? 12.5) * (term.options.lineHeight ?? 1.25);
    // Full-screen CLIs (alternate screen) scroll themselves: one wheel step per row of finger
    // travel, so a fast swipe loses no steps and both directions move alike (PM-114). xterm
    // turned each touch event into at most one step before, whatever its distance.
    const flushAlternateScroll = () => {
      const row = rowHeight();
      const lines = Math.trunc(touchRemainder / row);
      for (let i = 0; i < Math.abs(lines); i++) {
        term.element?.dispatchEvent(
          new WheelEvent('wheel', {
            deltaY: Math.sign(lines),
            deltaMode: WheelEvent.DOM_DELTA_LINE,
            clientX: touchX,
            clientY: touchY ?? 0,
            bubbles: true,
            cancelable: true,
          }),
        );
      }
      touchRemainder -= lines * row;
    };
    const flushTouchScroll = () => {
      scrollFrame = null;
      if (cancelled) return;
      if (term.buffer.active.type !== 'normal') return flushAlternateScroll();
      const element = viewport();
      if (element) {
        const maximum = Math.max(0, element.scrollHeight - element.clientHeight);
        // Continue from our own fractional position (xterm rounds the view to whole rows),
        // unless xterm moved the view by a row or more itself: the oldest lines dropping off as
        // output streams in, or a jump to the bottom. Snapping back then stuttered (PM-114).
        let base = pixelTarget ?? element.scrollTop;
        if (Math.abs(element.scrollTop - base) >= rowHeight()) base = element.scrollTop;
        pixelTarget = Math.max(0, Math.min(maximum, base + touchRemainder));
        element.scrollTop = pixelTarget;
        if (pixelTarget >= maximum - 2) {
          term.scrollToBottom();
        } else if (pixelTarget <= 2) {
          term.scrollToTop();
        }
        touchRemainder = 0;
        return;
      }
      const row = rowHeight();
      const lines = Math.trunc(touchRemainder / row);
      if (lines) {
        term.scrollLines(lines);
        touchRemainder -= lines * row;
      }
    };
    const onTouchStart = (event: TouchEvent) => {
      if (event.touches.length === 1) event.stopPropagation();
      if (momentumFrame !== null) cancelAnimationFrame(momentumFrame);
      momentumFrame = null;
      velocity = 0;
      pixelTarget = viewport()?.scrollTop ?? null;
      lastMove = performance.now();
      if (scrollFrame !== null) {
        cancelAnimationFrame(scrollFrame);
        flushTouchScroll();
      }
      touchY = event.touches.length === 1 ? event.touches[0]!.clientY : null;
      touchX = event.touches[0]?.clientX ?? 0;
      touchRemainder = 0;
    };
    const onTouchMove = (event: TouchEvent) => {
      if (touchY === null || event.touches.length !== 1) return;
      event.stopPropagation();
      const y = event.touches[0]!.clientY;
      const delta = touchY - y;
      if (Math.abs(delta) < 1) return;
      touchY = y;
      lastTouchScrollTime = Date.now();
      const now = performance.now();
      const elapsed = Math.max(1, now - lastMove);
      const instantVelocity = Math.max(-15, Math.min(15, delta / elapsed));
      velocity = velocity * 0.25 + instantVelocity * 0.75;
      // A direction change should follow the finger immediately, not retain the old flick.
      if (velocity * delta < 0) velocity = instantVelocity;
      lastMove = now;
      event.preventDefault(); // The swipe scrolls the terminal, not the page around it.
      touchRemainder += delta;
      if (term.buffer.active.type === 'normal') {
        // Scroll the entire terminal viewport, including the CLI's prompt/footer. Sending
        // mouse reports instead lets the CLI scroll only its output pane and pins its chrome.
        // Coalesce rapid touch events into one viewport update per display frame.
        if (scrollFrame === null) scrollFrame = requestAnimationFrame(flushTouchScroll);
        return;
      }
      flushAlternateScroll();
    };
    const onTouchEnd = (event: TouchEvent) => {
      touchY = null;
      // Both kinds of screen coast after a flick, in either direction (PM-114).
      const normal = term.buffer.active.type === 'normal';
      if (
        event.type === 'touchcancel' ||
        (normal && !viewport()) ||
        performance.now() - lastMove > 120 ||
        Math.abs(velocity) < 0.05 ||
        window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
      )
        return;
      let previous = performance.now();
      const coast = (now: number) => {
        if (cancelled) return;
        const elapsed = Math.min(32, now - previous);
        previous = now;
        touchRemainder += velocity * elapsed;
        flushTouchScroll();
        const element = normal ? viewport() : null;
        const maximum = element ? Math.max(0, element.scrollHeight - element.clientHeight) : 0;
        const atEdge =
          element &&
          pixelTarget !== null &&
          ((velocity > 0 && pixelTarget >= maximum) || (velocity < 0 && pixelTarget <= 0));
        if (atEdge && velocity > 0) {
          term.scrollToBottom();
        }
        velocity *= Math.exp(-elapsed / 320);
        if (!atEdge && Math.abs(velocity) > 0.05) momentumFrame = requestAnimationFrame(coast);
        else momentumFrame = null;
      };
      if (scrollFrame !== null) cancelAnimationFrame(scrollFrame);
      momentumFrame = requestAnimationFrame(coast);
    };
    const onFocusIn = () => {
      if (interactive && following) scrollToBottomAndSync();
    };
    // A scroll the reader made decides whether to keep following; any scroll that lands at the
    // bottom resumes it (scroll events don't bubble, so listen in the capture phase).
    const onGesture = (event: Event) => {
      lastGesture = Date.now();
      if (
        event instanceof WheelEvent &&
        event.deltaY < 0 &&
        term.buffer.active.type === 'normal' &&
        (viewport()?.scrollTop ?? 0) > 0
      )
        following = false;
    };
    const onScroll = (event: Event) => {
      const element = viewport();
      if (!element || event.target !== element) return;
      if (atBottom(element)) following = true;
      else if (Date.now() - lastGesture < 600 || Date.now() - lastTouchScrollTime < 600)
        following = false;
    };
    host.addEventListener('focusin', onFocusIn);
    host.addEventListener('wheel', onGesture, { passive: true, capture: true });
    host.addEventListener('pointerdown', onGesture, { passive: true, capture: true });
    host.addEventListener('keydown', onGesture, { passive: true, capture: true });
    host.addEventListener('scroll', onScroll, { passive: true, capture: true });
    host.addEventListener('touchstart', onTouchStart, { passive: true, capture: true });
    host.addEventListener('touchmove', onTouchMove, { passive: false, capture: true });
    host.addEventListener('touchend', onTouchEnd);
    host.addEventListener('touchcancel', onTouchEnd);
    const pasteTarget = callbacks.current.pasteRef;
    if (pasteTarget && interactive) pasteTarget.current = (text) => term.paste(text);
    // Copy the controller: cleanup must not read a ref that may have changed by then.
    const controller = ctl.current;

    const stopLoop = () => {
      controller.polling = false;
    };

    const write = (
      data: string,
      nextOffset: number,
      terminalSize?: AgentOutput['terminalSize'],
    ) => {
      if (cancelled) return;
      // Ignore anything older than what we've shown (e.g. a reconnect racing a poll).
      if (nextOffset <= offsetRef.current) return;
      const start = offsetRef.current;
      if (data) receivedOutput = true;
      if (stopped && start === initialOffset && terminalSize)
        term.resize(terminalSize.cols, terminalSize.rows);
      offsetRef.current = nextOffset;

      // When tailing a large log, discard the partial leading line fragment before the first newline
      let cleanData = data;
      if (initialOffset > 0 && start === initialOffset && cleanData) {
        const firstNl = cleanData.indexOf('\n');
        if (firstNl !== -1 && firstNl < 1000) {
          cleanData = cleanData.slice(firstNl + 1);
        }
      }

      if (start < historyRef.current) {
        replaying.current++;
        term.write(cleanData, () => {
          if (cancelled) return;
          replaying.current--;
          if (nextOffset >= restoreBytes) reveal();
        });
      } else {
        const userScrolling = Date.now() - lastTouchScrollTime < 1500;
        const shouldStick = interactive && !userScrolling && following;
        term.write(cleanData, () => {
          if (cancelled) return;
          markConnection('ready');
          // Once per frame, not per chunk: it reads layout, and a busy TUI sends many chunks a
          // frame (phones lagged).
          if (shouldStick && stickFrame === null)
            stickFrame = requestAnimationFrame(() => {
              stickFrame = null;
              if (!cancelled) scrollToBottomAndSync();
            });
        });
      }
    };

    function connect() {
      if (cancelled || controller.polling) return;
      controller.polling = true;
      // Reconnect manually from our own offset: EventSource's built-in retry would replay the
      // original URL and duplicate output.
      const source = new EventSource(callbacks.current.streamUrl!(offsetRef.current));
      controller.source = source;
      source.addEventListener('output', (event) => {
        serverResponded = true;
        const { data, nextOffset, terminalSize } = JSON.parse(
          (event as MessageEvent<string>).data,
        ) as {
          data: string;
          nextOffset: number;
          terminalSize?: AgentOutput['terminalSize'];
        };
        write(data, nextOffset, terminalSize);
      });
      source.addEventListener('state', () => {
        serverResponded = true;
        revealDrained();
      });
      source.onerror = () => {
        if (cancelled || callbacks.current.paused || controller.source !== source) return;
        source.close();
        if (controller.source === source) controller.source = null;
        stopLoop();
        markConnection('reconnecting');
        controller.timer = setTimeout(poll, 1000);
      };
    }

    // Loop step. Only start() checks `polling` (one loop at a time); the loop's own scheduled
    // continuation must not, or polling stops after the first fetch.
    async function poll() {
      if (cancelled) return;
      controller.polling = true;
      try {
        const out = await callbacks.current.fetchOutput(offsetRef.current);
        if (cancelled) return;
        serverResponded = true;
        if (out.data) write(out.data, out.nextOffset, out.terminalSize);
        else revealDrained();
        if (callbacks.current.paused) {
          stopLoop();
          return;
        }
        // A finished process drains first: keep reading while bytes arrive.
        if (!out.running && !out.data) {
          stopLoop();
          return;
        }
        controller.timer = setTimeout(
          () => {
            if (streaming) {
              stopLoop();
              start();
            } else void poll();
          },
          out.running ? pollMs : 250,
        );
      } catch {
        if (cancelled || callbacks.current.paused) return;
        markConnection('reconnecting');
        // Preserve any parsed output instead of leaving a permanently hidden terminal.
        if (restoring)
          term.write('', () => {
            if (!cancelled) {
              reveal();
              requestAnimationFrame(() => {
                if (!cancelled) markConnection('reconnecting');
              });
            }
          });
        // Transient fetch failure: keep the old output, try again.
        controller.timer = setTimeout(poll, pollMs);
      }
    }

    const start = () => {
      if (cancelled || !opened || controller.polling || callbacks.current.paused) return;
      clearTimeout(recoveryTimer);
      recoveryTimer = setTimeout(() => {
        if (restoring || !serverResponded) retry();
      }, 4000);
      if (streaming) connect();
      else poll();
    };
    const retry = () => {
      if (cancelled || !opened || callbacks.current.paused) return;
      clearTimeout(controller.timer);
      controller.source?.close();
      controller.source = null;
      stopLoop();
      void poll();
    };
    live.current = { term, refit, start, retry };

    // Open on the next frame: xterm schedules viewport work right after open(), which throws if
    // the terminal is disposed first — exactly what StrictMode's throwaway mount does. A mount
    // that is cleaned up before this frame never opens at all.
    let releaseWebgl: (() => void) | null = null;
    const openFrame = requestAnimationFrame(() => {
      if (cancelled) return;
      term.open(host);
      // GPU rendering (PM-190): the default DOM renderer rebuilds styled HTML for every cell, and
      // full-screen TUIs (OpenCode, Grok) repaint whole colour screens many times a second, which
      // made phones lag. Falls back to the DOM renderer without WebGL or if the context is lost
      // (browsers cap live contexts).
      // Only where it pays: a finished log is static, a software renderer (SwiftShader, llvmpipe)
      // is slower than the DOM, and each context is a scarce browser resource.
      if (!stopped && webglTerminals < MAX_WEBGL_TERMINALS && hasHardwareWebgl()) {
        try {
          const webgl = new WebglAddon();
          webglTerminals++;
          releaseWebgl = () => {
            releaseWebgl = null;
            webglTerminals--;
          };
          webgl.onContextLoss(() => {
            releaseWebgl?.();
            webgl.dispose();
          });
          term.loadAddon(webgl);
        } catch {
          // No WebGL here: the DOM renderer keeps working.
          releaseWebgl?.();
        }
      }
      // Older logs have no geometry markers; start with the supervisor's PTY default.
      if (stopped) term.resize(120, 30);
      opened = true;
      refit();
      resize.observe(host);
      window.addEventListener('resize', scheduleRefit);
      if (interactive && !restoring && !callbacks.current.paused) term.focus();
      start();
    });

    return () => {
      live.current = null;
      cancelled = true;
      clearTimeout(recoveryTimer);
      controller.polling = false;
      cancelAnimationFrame(openFrame);
      if (revealFrame !== null) cancelAnimationFrame(revealFrame);
      if (stickFrame !== null) cancelAnimationFrame(stickFrame);
      host.style.visibility = '';
      host.removeAttribute('aria-busy');
      if (scrollFrame !== null) cancelAnimationFrame(scrollFrame);
      if (momentumFrame !== null) cancelAnimationFrame(momentumFrame);
      if (controller.timer) clearTimeout(controller.timer);
      controller.source?.close();
      controller.source = null;
      inputSub?.dispose();
      geometry.dispose();
      host.removeEventListener('focusin', onFocusIn);
      host.removeEventListener('paste', onPaste, true);
      host.removeEventListener('dragover', onDragOver);
      host.removeEventListener('drop', onDrop);
      host.removeEventListener('wheel', onGesture, true);
      host.removeEventListener('pointerdown', onGesture, true);
      host.removeEventListener('keydown', onGesture, true);
      host.removeEventListener('scroll', onScroll, true);
      host.removeEventListener('touchstart', onTouchStart, true);
      host.removeEventListener('touchmove', onTouchMove, true);
      host.removeEventListener('touchend', onTouchEnd);
      host.removeEventListener('touchcancel', onTouchEnd);
      if (pasteTarget) pasteTarget.current = null;
      window.removeEventListener('resize', scheduleRefit);
      clearTimeout(resizeTimer);
      resize.disconnect();
      term.dispose();
      releaseWebgl?.();
    };
  }, [pollMs, interactive, streaming, stopped]);

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
      terminal?.refit();
      terminal?.start();
      const frame = requestAnimationFrame(() => {
        const host = hostRef.current;
        if (interactive && host && !host.hasAttribute('aria-busy')) live.current?.term.focus();
      });
      return () => cancelAnimationFrame(frame);
    }
  }, [paused, interactive]);

  useEffect(() => {
    const current = live.current;
    if (!current || current.term.options.fontSize === fontSize) return;
    current.term.options.fontSize = fontSize;
    current.refit(); // New cell size: recompute cols/rows and tell the PTY.
  }, [fontSize]);

  return (
    <div
      className={`terminal-shell${stopped ? ' is-stopped' : ''}${interactive ? ' is-interactive' : ''}`}
      style={{ height }}
    >
      {connection !== 'ready' && (
        <div className={`terminal-notice${cliShown ? '' : ' is-centered'}`} role="status">
          {connection === 'loading'
            ? 'Loading terminal…'
            : connection === 'reconnecting'
              ? 'Reconnecting…'
              : stopped
                ? 'No recorded output'
                : 'Waiting for CLI output…'}
          {connection === 'reconnecting' && (
            <button type="button" className="link-button" onClick={() => live.current?.retry()}>
              Retry
            </button>
          )}
        </div>
      )}
      <div
        ref={hostRef}
        className={`terminal${interactive ? ' is-interactive' : ''}`}
        role={interactive ? 'application' : 'log'}
        aria-label={
          interactive ? 'Interactive terminal (keystrokes go to the session)' : 'Terminal output'
        }
        onClick={() => {
          hostRef.current?.querySelector('textarea')?.focus();
          live.current?.term.scrollToBottom();
        }}
      />
      {interactive &&
        createPortal(
          <div
            ref={keysRef}
            className="terminal-keys"
            data-keyboard-open={keyboardOpen || undefined}
            role="group"
            aria-label="Terminal keyboard shortcuts"
          >
            <div className="terminal-key-row">
              <div className="terminal-key-scroll">
                {[
                  ['Esc', '\x1b', 'Escape'],
                  ['Tab', '\t', 'Tab'],
                  ['↑', '\x1b[A', 'Arrow up'],
                  ['↓', '\x1b[B', 'Arrow down'],
                  ['←', '\x1b[D', 'Arrow left'],
                  ['→', '\x1b[C', 'Arrow right'],
                ].map(([label, data, name]) => (
                  <button
                    key={name}
                    type="button"
                    aria-label={name}
                    disabled={paused}
                    onPointerDown={(event) => event.preventDefault()}
                    onClick={() => sendKey(data!)}
                  >
                    {label}
                  </button>
                ))}
                <>
                  {[
                    ['Ctrl+A', '\x01', 'Control A'],
                    ['Ctrl+C', '\x03', 'Interrupt (Control C)'],
                    ['Ctrl+D', '\x04', 'End input (Control D)'],
                    ['Ctrl+Z', '\x1a', 'Suspend (Control Z)'],
                    ['Ctrl+L', '\x0c', 'Clear screen (Control L)'],
                    ['Ctrl+G', '\x07', 'Control G'],
                    ['Shift+Tab', '\x1b[Z', 'Shift Tab'],
                    ['Ins', '\x1b[2~', 'Insert'],
                    ['Del', '\x1b[3~', 'Delete'],
                    ['Home', '\x1b[H', 'Home'],
                    ['End', '\x1b[F', 'End'],
                    ['PgUp', '\x1b[5~', 'Page up'],
                    ['PgDn', '\x1b[6~', 'Page down'],
                    ...(extraKeys
                      ? Array.from({ length: 12 }, (_, i) => [
                          `F${i + 1}`,
                          i < 4
                            ? `\x1bO${'PQRS'[i]}`
                            : `\x1b[${[15, 17, 18, 19, 20, 21, 23, 24][i - 4]}~`,
                          `Function ${i + 1}`,
                        ])
                      : []),
                  ].map(([label, data, name]) => (
                    <button
                      key={name}
                      type="button"
                      aria-label={name}
                      disabled={paused}
                      onPointerDown={(event) => event.preventDefault()}
                      onClick={() => sendKey(data!)}
                    >
                      {label}
                    </button>
                  ))}
                </>
                <button
                  type="button"
                  aria-label="Function keys"
                  aria-expanded={extraKeys}
                  onPointerDown={(event) => event.preventDefault()}
                  onClick={() => setExtraKeys((value) => !value)}
                >
                  F1–F12
                </button>
              </div>
              <button
                type="button"
                aria-label="Hide keyboard"
                onPointerDown={(event) => event.preventDefault()}
                onClick={() => hostRef.current?.querySelector('textarea')?.blur()}
              >
                <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
                  <path
                    d="m5 7.5 5 5 5-5"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
