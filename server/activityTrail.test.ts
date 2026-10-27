import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it } from 'vitest';
import { recentRequests, traceRequests } from './activityTrail.js';

describe('activityTrail', () => {
  it('records method and path without the query and marks open requests', () => {
    const res = new EventEmitter() as unknown as ServerResponse;
    traceRequests(() => undefined)(
      { method: 'GET', url: '/api/x?token=secret' } as IncomingMessage,
      res,
    );
    const open = recentRequests(5000);
    expect(open[0]).toMatch(/^GET \/api\/x \d+ms \(still open\)$/);
    expect(open.join()).not.toContain('secret');
    res.emit('close');
    expect(recentRequests(5000)[0]).not.toContain('still open');
  });
});
