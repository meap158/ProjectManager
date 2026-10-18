import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, describe, expect, it } from 'vitest';
import { antigravityItems, decodeMessage } from './antigravityTranscript.js';
import { readProviderTranscript } from './providerTranscripts.js';

// A minimal protobuf encoder, enough to build the steps Antigravity writes.
type Field = [number, number | string | Buffer | Field[]];
function varint(n: number): Buffer {
  const out: number[] = [];
  let v = n;
  do {
    let b = v & 0x7f;
    v = Math.floor(v / 128);
    if (v) b |= 0x80;
    out.push(b);
  } while (v);
  return Buffer.from(out);
}
function encode(fields: Field[]): Buffer {
  return Buffer.concat(
    fields.map(([field, value]) => {
      if (typeof value === 'number') return Buffer.concat([varint(field << 3), varint(value)]);
      const bytes =
        typeof value === 'string'
          ? Buffer.from(value)
          : Buffer.isBuffer(value)
            ? value
            : encode(value);
      return Buffer.concat([varint((field << 3) | 2), varint(bytes.length), bytes]);
    }),
  );
}
const created = (s: number): Field => [5, [[1, [[1, s]]]]];
const user = (text: string) => encode([[1, 14], created(1_800_000_000), [19, [[2, text]]]]);
const turn = (reply: string, thought: string, call?: [string, string, string]) =>
  encode([
    [1, 15],
    created(1_800_000_001),
    [
      20,
      [
        [1, reply],
        [3, thought],
        ...(call
          ? ([
              [
                7,
                [
                  [1, call[0]],
                  [2, call[1]],
                  [3, call[2]],
                ],
              ],
            ] as Field[])
          : []),
      ],
    ],
  ]);
const toolStep = (id: string, name: string, args: string, output: string, summary: string) =>
  encode([
    [1, 132],
    [
      5,
      [
        [1, [[1, 1_800_000_002]]],
        [
          4,
          [
            [1, id],
            [2, name],
            [3, args],
          ],
        ],
      ],
    ],
    [
      140,
      [
        [
          1,
          [
            [1, 'toolSummary'],
            [2, summary],
          ],
        ],
        [2, [[1, output]]],
      ],
    ],
  ]);
const error = (message: string) =>
  encode([
    [1, 17],
    [24, [[3, [[1, message]]]]],
  ]);

describe('Antigravity transcripts', () => {
  it("decodes protobuf without a schema and rejects what isn't one", () => {
    const fields = decodeMessage(
      encode([
        [1, 7],
        [2, 'hi'],
      ]),
    );
    expect(fields?.get(1)).toEqual([7n]);
    expect(String(fields?.get(2)?.[0])).toBe('hi');
    expect(decodeMessage(Buffer.from([0x0a, 0x09, 0x01]))).toBeNull(); // Length past the end.
  });

  it('reads messages, reasoning, tool calls with results and errors from the steps', () => {
    const args = JSON.stringify({ TargetFile: 'src/app.ts', Instruction: 'Rename it' });
    const items = antigravityItems([
      { idx: 1, type: 14, payload: user('Rename the helper') },
      {
        idx: 2,
        type: 15,
        payload: turn('', 'Plan: edit app.ts', ['call_1', 'replace_file_content', args]),
      },
      {
        idx: 3,
        type: 132,
        payload: toolStep(
          'call_1',
          'replace_file_content',
          args,
          'Changed app.ts',
          'Rename the helper in app.ts',
        ),
      },
      { idx: 4, type: 15, payload: turn('Done: renamed.', '') },
      { idx: 5, type: 17, payload: error('Individual quota reached.') },
      { idx: 6, type: 99, payload: Buffer.from('not a step we know') },
    ]);
    expect(items.map((i) => [i.kind, i.text ?? i.summary])).toEqual([
      ['user', 'Rename the helper'],
      ['note', 'Plan: edit app.ts'],
      ['tool', 'Rename the helper in app.ts'],
      ['result', 'Changed app.ts'],
      ['assistant', 'Done: renamed.'],
      ['note', 'Error: Individual quota reached.'],
    ]);
    // The tool step's result belongs to the call the model turn made: one tool, not two.
    expect(items.filter((i) => i.kind === 'tool')).toHaveLength(1);
    expect(items[2]?.name).toBe('replace_file_content');
    expect(items[0]?.at).toBe(new Date(1_800_000_000_000).toISOString());
  });

  const home = mkdtempSync(path.join(os.tmpdir(), 'pm-agy-'));
  afterAll(() => rmSync(home, { recursive: true, force: true }));
  const conversation = '6e91a3b2-1e71-4f2f-b58f-463b12c2c41b';
  const cwd = path.join(home, 'project');
  const dir = path.join(home, '.gemini', 'antigravity-cli', 'conversations');
  mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(path.join(dir, `${conversation}.db`));
  db.exec(
    'CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, step_payload BLOB); CREATE TABLE trajectory_metadata_blob (id TEXT, data BLOB);',
  );
  db.prepare('INSERT INTO trajectory_metadata_blob VALUES (?, ?)').run(
    'main',
    encode([[1, [[1, pathToFileURL(cwd).href]]]]),
  );
  db.prepare('INSERT INTO steps VALUES (?, ?, ?)').run(1, 14, user('Hello there'));
  db.close();
  const resume = JSON.stringify(['agy', '--conversation', conversation]);

  it("reads only the pinned conversation of the session's own folder", async () => {
    const read = await readProviderTranscript('antigravity', resume, cwd, undefined, home);
    expect(read.supported).toBe(true);
    expect(read.items.map((i) => i.text)).toEqual(['Hello there']);
    const elsewhere = await readProviderTranscript(
      'antigravity',
      resume,
      path.join(home, 'other'),
      undefined,
      home,
    );
    expect(elsewhere.items).toEqual([]);
  });

  it('says why when a session has no pinned conversation, never guessing the newest', async () => {
    const read = await readProviderTranscript(
      'antigravity',
      JSON.stringify(['agy']),
      cwd,
      undefined,
      home,
    );
    expect(read.supported).toBe(false);
    expect(read.unavailable).toMatch(/pinned its conversation/);
  });
});
