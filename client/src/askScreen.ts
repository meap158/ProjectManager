// What a CLI is asking (PM-801). Chat mode used to show the terminal's screen as it was drawn:
// 12px monospace in a scrolling box, with the CLI's own borders, cursor marks and padding. This
// reads that screen into a question, numbered options with their descriptions, and a key hint, so
// the phone can show them as text. A screen that does not look like a menu returns null and is
// shown raw, so nothing is ever hidden by a wrong guess.

export interface AskOption {
  number: number;
  label: string;
  description: string;
  /** The CLI's cursor is on this option (the one Enter would pick). */
  current: boolean;
}

export interface AskScreen {
  /** A short tag some CLIs draw above the question ("Layout"). */
  header: string | null;
  question: string;
  options: AskOption[];
  hint: string | null;
}

const BORDER = /[│┃║╭╮╰╯┌┐└┘├┤┬┴┼╔╗╚╝]/g;
const RULE = /^[\s─━═┄┈╌╍-]{3,}$/;
const POINTER = '❯›▶►→>»';
const OPTION = new RegExp(
  `^(\\s*)([${POINTER}])?\\s*(?:\\[[ xX✔✓]\\]|[☐☒☑✔✓])?\\s*(\\d{1,2})[.)]\\s+(\\S.*)$`,
);
const HINT = /(\benter to\b|\besc to\b|↑\s*\/?\s*↓|\bto navigate\b|\bto select\b|\barrow keys\b)/i;
const HEADER = /^[☐☒☑✔✓■□]\s+(\S.*)$/;

/** Reads a drawn screen. Null when it has fewer than two numbered options. */
export function parseAsk(screen: string): AskScreen | null {
  const lines = screen
    .replace(/\r/g, '')
    .split('\n')
    .map((raw) => raw.replace(BORDER, ' ').replace(/\s+$/, ''));
  const options: AskOption[] = [];
  const before: string[] = [];
  let hint: string | null = null;
  let indent = 0;
  let open = false;
  for (const line of lines) {
    const text = line.trim();
    if (!text || RULE.test(line)) {
      open = false;
      continue;
    }
    if (HINT.test(text)) {
      hint = text;
      open = false;
      continue;
    }
    const match = OPTION.exec(line);
    if (match) {
      options.push({
        number: Number(match[3]),
        label: match[4]!.trim(),
        description: '',
        current: !!match[2],
      });
      indent = match[1]!.length;
      open = true;
      continue;
    }
    if (open && options.length) {
      const last = options[options.length - 1]!;
      // A description sits under its option, indented past the pointer column.
      if (line.length - line.trimStart().length > indent) {
        last.description = last.description ? `${last.description} ${text}` : text;
        continue;
      }
      open = false;
    }
    if (!options.length) before.push(text);
  }
  if (options.length < 2) return null;
  let header: string | null = null;
  const first = before[0] ? HEADER.exec(before[0]) : null;
  if (first && before.length > 1) {
    header = first[1]!.trim();
    before.shift();
  }
  return { header, question: before.join('\n'), options, hint };
}
