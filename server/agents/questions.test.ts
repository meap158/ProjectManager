import { describe, expect, it } from 'vitest';
import type { ChatItem } from '../../shared/types.js';
import { QuestionCache, askedQuestion, lastReplyText } from './questions.js';

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
  // PM-315: from the running sessions on 2026-10-27, and edge cases.
  [
    "It would need an ad-unit ID that you create in AdSense. I'd build it desktop-only with reserved height, once you have the ID.\nShould I click Apply with the settings above?",
    /^Should I click Apply with the settings above\?$/,
  ],
  ['Bạn có muốn mình triển khai luôn không?', /không\?$/],
  ['どちらのデザインにしますか？', /？$/],
  ['Two questions. Should the banner stay? And which colour do you want?', /^And which colour/],
  [
    'The draft is in `docs/plan.md`. Can you check the numbers in the "Costs" table?',
    /^Can you check/,
  ],
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
  // PM-315: status notes that point at work elsewhere are not chat questions.
  'Still waiting on you: the xAI video credential on the Owner desk.',
  'Everything else waiting on you: HT-2 (GitHub billing) and HT-5 (the store listing).',
  'Blocked on you for the Apple developer account; it is on the Owner desk as HT-3.',
  // Quoted text and inline code are not the agent asking.
  'Next, PM-315: the detector flags status notes like "Still waiting on you: the xAI video credential…" as questions. Reading the detector.',
  'The banner now reads "Do you want cookies?" in both languages.',
  'Renamed `canYouSee?` to `isVisible`.',
  // A rhetorical question the reply goes on to answer.
  'Why did the build fail? The cache held a stale lockfile from before the upgrade, so I cleared it, reinstalled and reran every check, which all pass now.',
  // Real endings from running sessions that wait on no one.
  "If the thresholds look wrong, run ghost-jobs against your real data and send me what it flags, and I'll tune them.",
  'I left the old fix/ink-throw-status branch on GitHub; it can be deleted whenever you like.',
  '3. Reef music: say go if you want a Lyria track for the reef. Until then it keeps the lagoon music.',
  'No response requested.',
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

describe('QuestionCache', () => {
  it("never shows the last turn's question once you have replied, while the new reply is read", async () => {
    // A provider without a transcript file (read in full): its last reply asks something.
    const cache = new QuestionCache(() => ({ providerId: 'shell', resumeJson: null, cwd: '/' }));
    const internals = cache as unknown as {
      entries: Map<number, { version: string; turn: string; question: string | null }>;
    };
    internals.entries.set(1, { version: 'v1', turn: 't1', question: 'Do you want X?' });
    expect(cache.get(1, 'v1', 't1')).toBe('Do you want X?');
    // Only redraws since: the same turn, still shown while it re-checks.
    expect(cache.get(1, 'v2', 't1')).toBe('Do you want X?');
    // You replied (a new turn): nothing until the new reply is read.
    expect(cache.get(1, 'v3', 't2')).toBeNull();
    await new Promise((r) => setTimeout(r, 0));
    expect(cache.get(1, 'v3', 't2')).toBeNull(); // No transcript for a shell: nothing asked.
  });
});
