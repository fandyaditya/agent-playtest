import { describe, expect, it } from "vitest";
import { SerialQueue } from "../../src/daemon/queue.ts";

describe("SerialQueue", () => {
  it("runs tasks one at a time in submission order", async () => {
    const queue = new SerialQueue();
    const order: string[] = [];

    const slow = queue.run(async () => {
      order.push("slow:start");
      await new Promise((resolve) => setTimeout(resolve, 20));
      order.push("slow:end");
      return "slow";
    });
    const fast = queue.run(async () => {
      order.push("fast");
      return "fast";
    });

    expect(await fast).toBe("fast");
    expect(order).toEqual(["slow:start", "slow:end", "fast"]);
    expect(await slow).toBe("slow");
  });

  it("does not let a rejected task stall the queue", async () => {
    const queue = new SerialQueue();

    const failed = queue.run(async () => {
      throw new Error("boom");
    });
    const next = queue.run(async () => "ok");

    await expect(failed).rejects.toThrow("boom");
    await expect(next).resolves.toBe("ok");
    expect(queue.pending).toBe(0);
  });

  it("rejects work above the pending bound instead of growing forever", async () => {
    const queue = new SerialQueue(1);
    const blocker = queue.run(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });

    await expect(queue.run(async () => "second")).rejects.toThrow(/queue is full/);
    await blocker;
  });
});
