import { parsePositiveInt } from "@/lib/core/env";
import { JobTimeoutError, runWithDeadline } from "@/lib/core/queue";

describe("parsePositiveInt", () => {
  it("rejects zero, NaN, and negatives", () => {
    expect(parsePositiveInt("0", 16)).toBe(16);
    expect(parsePositiveInt("abc", 16)).toBe(16);
    expect(parsePositiveInt("-3", 16)).toBe(16);
    expect(parsePositiveInt("32", 16)).toBe(32);
  });
});

describe("runWithDeadline", () => {
  it("does not leave an unhandled rejection when the handler outlives the deadline", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);

    try {
      await expect(
        runWithDeadline("job-1", 30, async (signal) => {
          await new Promise<void>((_resolve, reject) => {
            const timer = setTimeout(() => reject(new Error("late handler failure")), 120);
            signal.addEventListener(
              "abort",
              () => {
                clearTimeout(timer);
                reject(new Error("aborted"));
              },
              { once: true }
            );
          });
        })
      ).rejects.toBeInstanceOf(JobTimeoutError);

      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});
