// Kept apart from TerminalView so callers can use it without loading xterm.

/**
 * Replies a terminal generates by itself: device attributes, status and cursor-position
 * reports, focus in/out, and OSC/DCS answers. They mean something only to a process that is
 * listening right now, so they're never queued for a stopped session.
 */
const REPORT =
  // eslint-disable-next-line no-control-regex
  /^(?:\x1b\[[?>=]?[\d;]*[cnRIO]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1bP[^\x1b]*\x1b\\)+$/;

export const isTerminalReport = (data: string) => REPORT.test(data);
