/**
 * Coalesces bursts per key: a handler runs once the key has been quiet for the delay. Pokes that arrive while the
 * handler is running schedule exactly one more run afterwards, so a key never has two handlers at once.
 */
export class Debouncer {
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly running = new Map<string, Promise<void>>();
  private readonly rerun = new Map<string, number>();

  constructor(
    private readonly defaultDelayMs: number,
    private readonly handler: (key: string) => Promise<void>,
    private readonly onError: (key: string, err: unknown) => void = () => {},
  ) {}

  poke(key: string, delayMs = this.defaultDelayMs): void {
    if (this.running.has(key)) {
      const previous = this.rerun.get(key);
      this.rerun.set(key, previous === undefined ? delayMs : Math.min(previous, delayMs));
      return;
    }
    const existing = this.timers.get(key);
    if (existing) clearTimeout(existing);
    this.timers.set(
      key,
      setTimeout(() => this.fire(key), delayMs),
    );
  }

  private fire(key: string): void {
    this.timers.delete(key);
    const run = (async () => {
      try {
        await this.handler(key);
      } catch (err) {
        this.onError(key, err);
      }
    })().finally(() => {
      this.running.delete(key);
      const again = this.rerun.get(key);
      if (again !== undefined) {
        this.rerun.delete(key);
        this.poke(key, again);
      }
    });
    this.running.set(key, run);
  }

  get pending(): number {
    return this.timers.size + this.running.size;
  }

  /** Resolves once no timer or handler remains, flushing timers immediately. */
  async drain(): Promise<void> {
    while (this.timers.size || this.running.size) {
      for (const [key, timer] of [...this.timers]) {
        clearTimeout(timer);
        this.fire(key);
      }
      await Promise.all([...this.running.values()]);
    }
  }
}
