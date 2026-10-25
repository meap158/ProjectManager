import { describe, expect, it } from 'vitest';
import type { ChatItem } from '../../shared/types.js';
import { askedQuestion, lastReplyText } from './questions.js';

// Ends of real replies from running sessions (Oct 2026), labelled by whether they wait on you.
const ASKING: [string, RegExp][] = [
  [
    "- I didn't run a real ingest.\nThe remaining gap from the card is the ghost-job signal. Do you want me to build that next?",
    /^Do you want me to build that next\?$/,
  ],
  [
    '- I deleted my test dataset.\nneeds input: do you approve merging `runs-pagination` and then `social-miner` into `main`? That also fixes the startup problem above.',
    /^needs input: do you approve merging runs-pagination .* into main\?$/,
  ],
  [
    'The live probe remains blocked. Do you authorize reading the local YouTube OAuth token for one read-only Analytics query?\nAutomatic approval review rejected the attempt.',
    /^Do you authorize .* query\?$/,
  ],
  [
    "4. Follow Gate C in the SOP.\nTell me when the stack is up and I'll check the job and the tags myself.",
    /^Tell me when the stack is up/,
  ],
  ['Then say "rerun" and I\'ll finish the test fix.', /^Then say "rerun"/],
  ['Still waiting on your startled-pose pick (1, 2, 3 or none) and a "push".', /^Still waiting/],
];

const NOT_ASKING = [
  'To actually voice your videos, the ElevenLabs key or a running VoiceStudio is still needed; both are on your Owner desk.',
  'Still blocked on GitHub billing (HT-1).',
  "I'll merge #360 if the local deploy build passes, and post that result on the PR.",
  "You've hit your session limit · resets 4:10am (Asia/Bangkok)",
  '5. Make sure the background API worker is running.\n*(Note: Within this chat interface, I do not have a standalone direct video-rendering tool.)*',
  'Production build, three targeted browser tests, lint, TypeScript, and all 262 unit tests pass. Working tree is clean; nothing pushed.',
  'No duplicate invitations were sent.',
  "Vercel is still rate limited, so I'm leaving #358 unmerged. I'll run the device checks now.",
  // Offers don't wait on you.
  'If you want the remaining board features built, say "do PM-296".',
  'Say "do PM-298" if you want it built now.',
  'Let me know if anything looks off.',
  // A question in the middle of a long report was answered by the report.
  'Should I keep the old API? No: nothing calls it.\nRemoved it.\nAll tests pass.',
  // Code is not prose.
  'Done.\n```\nif (ok?) ask()?\n```',
];

describe('askedQuestion (PM-298)', () => {
  it.each(ASKING)('finds the question in %j', (reply, expected) => {
    expect(askedQuestion(reply)).toMatch(expected);
  });

  it.each(NOT_ASKING)('finds nothing in %j', (reply) => {
    expect(askedQuestion(reply)).toBeNull();
  });
});

describe('lastReplyText', () => {
  const item = (kind: string, text: string) => ({ kind, text }) as unknown as ChatItem;
  it('is the newest reply of the current turn, and none once you have written', () => {
    expect(lastReplyText([item('user', 'hi'), item('assistant', 'A'), item('tool', '')])).toBe('A');
    expect(lastReplyText([item('assistant', 'A'), item('user', 'next')])).toBeNull();
  });
});
