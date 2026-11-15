/**
 * A single-consumer queue that is filled by callbacks and drained with `for await`.
 *
 * `onClose` runs exactly once, when the queue ends, fails, or the consumer stops iterating.
 */
export class AsyncQueue<T> implements AsyncIterable<T> {
  readonly #items: T[] = [];
  readonly #onClose: () => void;
  #waiter:
    | { resolve: (result: IteratorResult<T>) => void; reject: (error: unknown) => void }
    | undefined;
  #state: "open" | "ended" | "failed" = "open";
  #failure: unknown;

  constructor(onClose: () => void = () => {}) {
    this.#onClose = onClose;
  }

  push(item: T): void {
    if (this.#state !== "open") return;
    const waiter = this.#takeWaiter();
    if (waiter) waiter.resolve({ done: false, value: item });
    else this.#items.push(item);
  }

  /** Ends the queue. Items already pushed are still delivered. */
  end(): void {
    if (this.#state !== "open") return;
    this.#state = "ended";
    this.#onClose();
    this.#takeWaiter()?.resolve({ done: true, value: undefined });
  }

  /** Fails the queue. Items already pushed are still delivered, then `error` is thrown. */
  fail(error: unknown): void {
    if (this.#state !== "open") return;
    this.#state = "failed";
    this.#failure = error;
    this.#onClose();
    this.#takeWaiter()?.reject(error);
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => this.#next(),
      return: async () => {
        this.end();
        return { done: true, value: undefined };
      },
    };
  }

  #next(): Promise<IteratorResult<T>> {
    const item = this.#items.shift();
    if (item !== undefined) return Promise.resolve({ done: false, value: item });
    if (this.#state === "ended") return Promise.resolve({ done: true, value: undefined });
    if (this.#state === "failed") return Promise.reject(this.#failure);
    return new Promise((resolve, reject) => {
      this.#waiter = { resolve, reject };
    });
  }

  #takeWaiter() {
    const waiter = this.#waiter;
    this.#waiter = undefined;
    return waiter;
  }
}
