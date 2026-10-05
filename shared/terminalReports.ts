// Replies a terminal generates by itself: device attributes, status and cursor-position reports,
// focus in/out, and OSC/DCS answers. They mean something only to a process listening right now,
// so they're never queued for a stopped session, and stripped from queued input before replay.
// Shared by the client (TerminalView callers) and the server (input queue).

const ONE = String.raw`\x1b\[[?>=]?[\d;]*[cnRIO]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1bP[^\x1b]*\x1b\\`;
const ONLY_REPORTS = new RegExp(`^(?:${ONE})+$`);
const ANY_REPORT = new RegExp(ONE, 'g');

/** True when `data` consists only of terminal-generated replies (no typing). */
export const isTerminalReport = (data: string) => ONLY_REPORTS.test(data);

/** `data` with every terminal-generated reply removed (typing is kept). */
export const stripTerminalReports = (data: string) => data.replace(ANY_REPORT, '');
