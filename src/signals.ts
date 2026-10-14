/**
 * Abort and timing helpers. Node 18 lacks `AbortSignal.any`, so signals are combined by hand.
 */

export interface TimedSignal {
  signal: AbortSignal;
  /** True when the timeout (rather than the caller's signal) aborted the request. */
  timedOut(): boolean;
  dispose(): void;
}

/** The reason a signal was aborted with, or a standard `AbortError` when none was given. */
export function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('This operation was aborted', 'AbortError');
}

/** Combines an optional caller signal with an optional timeout into one signal. */
export function withTimeout(timeoutMs: number | undefined, external?: AbortSignal): TimedSignal {
  const controller = new AbortController();
  let didTimeOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const onExternalAbort = (): void => controller.abort(external ? abortReason(external) : undefined);
  if (external?.aborted) onExternalAbort();
  else external?.addEventListener('abort', onExternalAbort, { once: true });

  if (timeoutMs !== undefined && timeoutMs > 0 && !controller.signal.aborted) {
    timer = setTimeout(() => {
      didTimeOut = true;
      controller.abort(new DOMException('The operation timed out', 'TimeoutError'));
    }, timeoutMs);
  }

  return {
    signal: controller.signal,
    timedOut: () => didTimeOut,
    dispose: () => {
      if (timer !== undefined) clearTimeout(timer);
      external?.removeEventListener('abort', onExternalAbort);
    },
  };
}

/** Resolves after `ms`, or rejects with the signal's reason when it aborts first. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortReason(signal));
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(abortReason(signal as AbortSignal));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Rejects with the signal's reason if it has already been aborted. */
export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortReason(signal);
}
