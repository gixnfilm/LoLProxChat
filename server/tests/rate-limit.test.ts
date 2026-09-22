import { describe, it, expect } from 'vitest';
import { TokenBucket, ConcurrencyLimiter, clientIp } from '../src/rate-limit.js';

describe('TokenBucket', () => {
  it('allows up to capacity tokens immediately, then rejects', () => {
    const b = new TokenBucket({ capacity: 3, refillPerSec: 1 });
    const t = 1_000_000;
    expect(b.tryConsume('ip1', t)).toBe(true);
    expect(b.tryConsume('ip1', t)).toBe(true);
    expect(b.tryConsume('ip1', t)).toBe(true);
    expect(b.tryConsume('ip1', t)).toBe(false);  // bucket empty
  });

  it('refills tokens at the configured rate', () => {
    const b = new TokenBucket({ capacity: 5, refillPerSec: 10 });
    const t0 = 1_000_000;
    // Drain it
    for (let i = 0; i < 5; i++) expect(b.tryConsume('ip1', t0)).toBe(true);
    expect(b.tryConsume('ip1', t0)).toBe(false);
    // 200 ms later we should have ~2 tokens back
    expect(b.tryConsume('ip1', t0 + 200)).toBe(true);
    expect(b.tryConsume('ip1', t0 + 200)).toBe(true);
    expect(b.tryConsume('ip1', t0 + 200)).toBe(false);
  });

  it('caps refill at capacity (no infinite accumulation)', () => {
    const b = new TokenBucket({ capacity: 3, refillPerSec: 1 });
    const t0 = 0;
    expect(b.tryConsume('ip1', t0)).toBe(true);
    // 1 hour later, should not have 3600 tokens — capped at 3
    const t1 = t0 + 60 * 60 * 1000;
    expect(b.tryConsume('ip1', t1)).toBe(true);
    expect(b.tryConsume('ip1', t1)).toBe(true);
    expect(b.tryConsume('ip1', t1)).toBe(true);
    expect(b.tryConsume('ip1', t1)).toBe(false);
  });

  it('tracks per-key buckets independently', () => {
    const b = new TokenBucket({ capacity: 2, refillPerSec: 0 });
    const t = 0;
    expect(b.tryConsume('ip1', t)).toBe(true);
    expect(b.tryConsume('ip1', t)).toBe(true);
    expect(b.tryConsume('ip1', t)).toBe(false);
    // ip2 has its own bucket, full
    expect(b.tryConsume('ip2', t)).toBe(true);
    expect(b.tryConsume('ip2', t)).toBe(true);
    expect(b.tryConsume('ip2', t)).toBe(false);
  });

  it('pruneIdle drops buckets older than idleMs', () => {
    const b = new TokenBucket({ capacity: 1, refillPerSec: 0 });
    b.tryConsume('ip1', 0);
    b.tryConsume('ip2', 1000);
    b.tryConsume('ip3', 5000);
    expect(b.size).toBe(3);
    const removed = b.pruneIdle(/*idleMs*/ 2000, /*now*/ 5000);
    expect(removed).toBe(2);   // ip1 (5s old) + ip2 (4s old) gone
    expect(b.size).toBe(1);    // ip3 (0s old) stays
  });
});

describe('ConcurrencyLimiter', () => {
  it('grants up to max acquires per key, then rejects', () => {
    const c = new ConcurrencyLimiter(3);
    expect(c.acquire('ip1')).toBe(true);
    expect(c.acquire('ip1')).toBe(true);
    expect(c.acquire('ip1')).toBe(true);
    expect(c.acquire('ip1')).toBe(false);
    expect(c.count('ip1')).toBe(3);
  });

  it('release decrements the count', () => {
    const c = new ConcurrencyLimiter(2);
    c.acquire('ip1');
    c.acquire('ip1');
    expect(c.acquire('ip1')).toBe(false);
    c.release('ip1');
    expect(c.acquire('ip1')).toBe(true);
  });

  it('release on last drops the key entirely', () => {
    const c = new ConcurrencyLimiter(2);
    c.acquire('ip1');
    c.release('ip1');
    expect(c.size).toBe(0);
  });

  it('tracks per-key independently', () => {
    const c = new ConcurrencyLimiter(1);
    expect(c.acquire('ip1')).toBe(true);
    expect(c.acquire('ip2')).toBe(true);   // separate key, fresh count
    expect(c.acquire('ip1')).toBe(false);
    expect(c.acquire('ip2')).toBe(false);
  });
});

describe('clientIp', () => {
  it('prefers x-forwarded-for first entry when present', () => {
    const ip = clientIp({
      headers: { 'x-forwarded-for': '1.2.3.4, 10.0.0.1' },
      socket: { remoteAddress: '127.0.0.1' },
    });
    expect(ip).toBe('1.2.3.4');
  });

  it('falls back to socket remoteAddress when no x-forwarded-for', () => {
    const ip = clientIp({
      headers: {},
      socket: { remoteAddress: '203.0.113.5' },
    });
    expect(ip).toBe('203.0.113.5');
  });

  it('ignores empty x-forwarded-for and falls back', () => {
    const ip = clientIp({
      headers: { 'x-forwarded-for': '' },
      socket: { remoteAddress: '203.0.113.5' },
    });
    expect(ip).toBe('203.0.113.5');
  });

  it('returns "unknown" if neither source has anything', () => {
    const ip = clientIp({ headers: {}, socket: {} });
    expect(ip).toBe('unknown');
  });
});
