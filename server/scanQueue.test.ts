import { describe, expect, it } from 'vitest';
import { openDb } from './db.js';
import { Scanner } from './scanner.js';

// Many projects added at once must not all scan at once (each scan runs scc, git and a disk walk).

describe('scan queue', () => {
  it('works on at most two scans at a time, first come first served', async () => {
    const scanner = new Scanner(openDb(':memory:'));
    const inTurn = (
      scanner as unknown as { inTurn: <T>(task: () => Promise<T>) => Promise<T> }
    ).inTurn.bind(scanner);
    let active = 0;
    let peak = 0;
    const order: number[] = [];
    const task = (n: number) => async () => {
      active++;
      peak = Math.max(peak, active);
      order.push(n);
      await new Promise((r) => setTimeout(r, 20));
      active--;
      return n;
    };
    const results = await Promise.all([1, 2, 3, 4, 5].map((n) => inTurn(task(n))));
    expect(results).toEqual([1, 2, 3, 4, 5]);
    expect(peak).toBe(2);
    expect(order).toEqual([1, 2, 3, 4, 5]);
  });

  it('frees the slot when a scan fails', async () => {
    const scanner = new Scanner(openDb(':memory:'));
    const inTurn = (
      scanner as unknown as { inTurn: <T>(task: () => Promise<T>) => Promise<T> }
    ).inTurn.bind(scanner);
    const fail = () => Promise.reject(new Error('boom'));
    await expect(inTurn(fail)).rejects.toThrow('boom');
    await expect(inTurn(fail)).rejects.toThrow('boom');
    await expect(inTurn(async () => 'ok')).resolves.toBe('ok');
  });
});
