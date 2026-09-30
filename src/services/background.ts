/**
 * Tracks work that continues after the HTTP response (the async completion + webhook postback).
 * On Node the promise simply keeps running; `idle()` lets shutdown and tests wait for it. On
 * runtimes with `waitUntil` (Workers), pass it so the platform keeps the request alive.
 */
export class BackgroundTasks {
  private readonly pending = new Set<Promise<void>>();

  run(task: () => Promise<void>, waitUntil?: (promise: Promise<unknown>) => void): void {
    const promise: Promise<void> = Promise.resolve()
      .then(task)
      .catch(() => {
        /* tasks handle and log their own errors */
      })
      .finally(() => this.pending.delete(promise));
    this.pending.add(promise);
    waitUntil?.(promise);
  }

  get size(): number {
    return this.pending.size;
  }

  /** Resolve once every task, including tasks started while waiting, has settled. */
  async idle(): Promise<void> {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }
}
