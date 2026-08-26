import { describe, it, expect, vi, afterEach } from 'vitest';
import { cacheMsgId, cacheEventId, getCachedReplyIds } from './msgid-cache.ts';

afterEach(() => {
  vi.useRealTimers();
});

describe('msgid-cache', () => {
  it('caches and returns the most recent msgId', () => {
    cacheMsgId('c2c', 'u-cache-1', 'm1');
    cacheMsgId('c2c', 'u-cache-1', 'm2');
    expect(getCachedReplyIds('c2c', 'u-cache-1')).toEqual([
      { kind: 'msg', id: 'm2' },
      { kind: 'msg', id: 'm1' },
    ]);
  });

  it('distinguishes msg and event kinds', () => {
    cacheMsgId('c2c', 'u-cache-2', 'm1');
    cacheEventId('c2c', 'u-cache-2', 'evt1');
    expect(getCachedReplyIds('c2c', 'u-cache-2')).toEqual([
      { kind: 'event', id: 'INTERACTION_CREATE:evt1' },
      { kind: 'msg', id: 'm1' },
    ]);
  });

  it('isolates by target', () => {
    cacheMsgId('c2c', 'u-cache-3', 'ma');
    cacheMsgId('c2c', 'u-cache-4', 'mb');
    expect(getCachedReplyIds('c2c', 'u-cache-3')).toEqual([{ kind: 'msg', id: 'ma' }]);
    expect(getCachedReplyIds('c2c', 'u-cache-4')).toEqual([{ kind: 'msg', id: 'mb' }]);
  });

  it('returns empty for an unknown target', () => {
    expect(getCachedReplyIds('c2c', 'u-nonexistent')).toEqual([]);
  });

  it('returns multiple cached ids in reverse chronological order', () => {
    cacheMsgId('c2c', 'u-cache-5', 'm1');
    cacheMsgId('c2c', 'u-cache-5', 'm2');
    cacheMsgId('c2c', 'u-cache-5', 'm3');
    expect(getCachedReplyIds('c2c', 'u-cache-5')).toEqual([
      { kind: 'msg', id: 'm3' },
      { kind: 'msg', id: 'm2' },
      { kind: 'msg', id: 'm1' },
    ]);
  });

  it('expires group messages after 5 minutes', () => {
    vi.useFakeTimers();
    cacheMsgId('group', 'g-cache-1', 'mg1');
    vi.advanceTimersByTime(5 * 60 * 1000 + 1);
    expect(getCachedReplyIds('group', 'g-cache-1')).toEqual([]);
  });
});
