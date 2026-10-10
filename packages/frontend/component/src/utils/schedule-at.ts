const MAX_TIMEOUT_DELAY = 2_147_483_647;

/** Schedule an absolute deadline, including deadlines beyond the timer limit. */
export function scheduleAt(deadline: number, callback: () => void) {
  if (!Number.isFinite(deadline)) {
    throw new RangeError('Timer deadline must be finite');
  }

  let timeout: ReturnType<typeof setTimeout> | undefined;
  let cancelled = false;
  const schedule = () => {
    if (cancelled) {
      return;
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      callback();
      return;
    }
    timeout = setTimeout(schedule, Math.min(remaining, MAX_TIMEOUT_DELAY));
    timeout.unref?.();
  };
  schedule();

  return () => {
    cancelled = true;
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  };
}
