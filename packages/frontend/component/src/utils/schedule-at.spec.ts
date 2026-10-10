import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { scheduleAt } from './schedule-at';

const DAY = 24 * 60 * 60 * 1000;

describe('scheduleAt', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-02T00:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test('keeps a 30-day invitation alive until its actual deadline', () => {
    const expire = vi.fn();
    scheduleAt(Date.now() + 30 * DAY, expire);

    vi.advanceTimersByTime(29 * DAY);
    expect(expire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(DAY - 1);
    expect(expire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(expire).toHaveBeenCalledTimes(1);
  });

  test('cancels the timer after a long deadline has been rescheduled', () => {
    const expire = vi.fn();
    const cancel = scheduleAt(Date.now() + 30 * DAY, expire);
    vi.advanceTimersByTime(25 * DAY);
    cancel();
    vi.advanceTimersByTime(10 * DAY);
    expect(expire).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  test('expires an invitation whose deadline has passed', () => {
    const expire = vi.fn();
    scheduleAt(Date.now() - 1, expire);
    expect(expire).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  test('rejects invalid deadlines explicitly', () => {
    expect(() => scheduleAt(NaN, vi.fn())).toThrow(RangeError);
    expect(() => scheduleAt(Infinity, vi.fn())).toThrow(RangeError);
  });
});
