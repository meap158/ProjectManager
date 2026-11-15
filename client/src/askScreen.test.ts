import { describe, expect, it } from 'vitest';
import { parseAsk } from './askScreen';

// What a CLI draws when it asks (PM-801), read into text for the chat view.

describe('parseAsk', () => {
  it('reads a question with a header, described options, the cursor and the key hint', () => {
    const screen = [
      '☐ Layout',
      '',
      'Which layout should the phone use?',
      '',
      '❯ 1. Stacked',
      '     one column',
      '  2. Tabs',
      '     tabbed sections',
      '  3. Type something.',
      '────────────────────',
      '  4. Chat about this',
      '',
      'Enter to select · ↑/↓ to navigate · Esc to cancel',
    ].join('\n');
    expect(parseAsk(screen)).toEqual({
      header: 'Layout',
      question: 'Which layout should the phone use?',
      options: [
        { number: 1, label: 'Stacked', description: 'one column', current: true },
        { number: 2, label: 'Tabs', description: 'tabbed sections', current: false },
        { number: 3, label: 'Type something.', description: '', current: false },
        { number: 4, label: 'Chat about this', description: '', current: false },
      ],
      hint: 'Enter to select · ↑/↓ to navigate · Esc to cancel',
    });
  });

  it('drops a drawn box and reads a permission prompt', () => {
    const screen = [
      '╭──────────────────────────────╮',
      '│ Do you want to proceed?      │',
      '│ ❯ 1. Yes                     │',
      "│   2. Yes, and don't ask again │",
      '│   3. No, and tell Claude why │',
      '╰──────────────────────────────╯',
    ].join('\n');
    const parsed = parseAsk(screen)!;
    expect(parsed.question).toBe('Do you want to proceed?');
    expect(parsed.options.map((o) => o.label)).toEqual([
      'Yes',
      "Yes, and don't ask again",
      'No, and tell Claude why',
    ]);
    expect(parsed.options[0]!.current).toBe(true);
  });

  it('keeps a multi-line question and joins a wrapped description', () => {
    const parsed = parseAsk(
      [
        'Pick one?',
        'It decides the layout.',
        '1. Shop card',
        '   a long',
        '   description',
        '2. Both',
      ].join('\n'),
    )!;
    expect(parsed.question).toBe('Pick one?\nIt decides the layout.');
    expect(parsed.options[0]!.description).toBe('a long description');
  });

  it('returns null for anything that is not a menu, so the raw screen stays', () => {
    expect(parseAsk('')).toBeNull();
    expect(parseAsk('Thinking…\n1. only one thing')).toBeNull();
    expect(parseAsk('> typing a message\nno options here')).toBeNull();
  });
});
