/**
 * Work that can stop halfway, done in the time a frame has to spare, so
 * none of it takes a frame whole. A piece of work is a generator that
 * yields between its parts; the frame loop (`Canvas.tsx`) runs parts after
 * each frame until the frame's budget is spent, and carries on the next.
 * Work runs in the order it was given, one piece after another, so what
 * must land in order lands in order.
 */

const queue: { parts: Iterator<unknown>; done: () => void }[] = [];

/** Work to do in frames' spare time: resolved when its last part has run. */
export function spread(parts: Iterable<unknown>): Promise<void> {
  return new Promise((done) => queue.push({ parts: parts[Symbol.iterator](), done }));
}

/** Parts of the work given, in order, until the clock reads `until`. */
export function work(until: number) {
  while (queue.length && performance.now() < until) {
    const job = queue[0];
    if (job.parts.next().done) {
      queue.shift();
      job.done();
    }
  }
}
