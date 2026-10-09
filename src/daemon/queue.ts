/**
 * Serializes requests per session.
 *
 * The daemon runs one browser session per project; read and mutating commands
 * share one queue so a snapshot can never race a navigation or a simulation
 * step. The queue is bounded so a misbehaving client cannot grow it forever.
 */

export class SerialQueue {
  #tail: Promise<unknown> = Promise.resolve();
  #pending = 0;
  #maxPending: number;

  constructor(maxPending = 32) {
    this.#maxPending = maxPending;
  }

  get pending(): number {
    return this.#pending;
  }

  run<T>(task: () => Promise<T>): Promise<T> {
    if (this.#pending >= this.#maxPending) {
      return Promise.reject(
        new Error(
          `Command queue is full (${this.#pending} pending); retry once the session is idle.`,
        ),
      );
    }
    this.#pending += 1;
    const start = () => {
      this.#pending -= 1;
      return task();
    };
    const result = this.#tail.then(start, start);
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
