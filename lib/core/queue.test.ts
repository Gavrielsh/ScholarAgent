import { UnrecoverableError } from "bullmq";

import { parseNonNegativeInt, parsePositiveInt } from "@/lib/core/env";
import {
  JobTimeoutError,
  runWithDeadline,
  TerminalNotifyError,
  UserNotifiedFailureError,
} from "@/lib/core/queue";

describe("parsePositiveInt", () => {
  it("rejects zero, NaN, and negatives", () => {
    expect(parsePositiveInt("0", 16)).toBe(16);
    expect(parsePositiveInt("abc", 16)).toBe(16);
    expect(parsePositiveInt("-3", 16)).toBe(16);
    expect(parsePositiveInt("32", 16)).toBe(32);
  });

  it("treats a blank or missing value as unset, never as 0", () => {
    // `X=` in a .env file arrives as "". `Number("" ?? 15_000)` is 0, which as a
    // timeout aborts every request instantly — the reason every env read goes
    // through these helpers.
    expect(parsePositiveInt("", 15_000)).toBe(15_000);
    expect(parsePositiveInt("   ", 15_000)).toBe(15_000);
    expect(parsePositiveInt(undefined, 15_000)).toBe(15_000);
  });
});

describe("parseNonNegativeInt", () => {
  it("accepts an explicit zero but falls back for blank, NaN and negatives", () => {
    expect(parseNonNegativeInt("0", 250)).toBe(0);
    expect(parseNonNegativeInt("40", 250)).toBe(40);
    expect(parseNonNegativeInt("", 250)).toBe(250);
    expect(parseNonNegativeInt(undefined, 250)).toBe(250);
    expect(parseNonNegativeInt("abc", 250)).toBe(250);
    expect(parseNonNegativeInt("-1", 250)).toBe(250);
  });
});

describe("terminal job errors", () => {
  it("UserNotifiedFailureError is unrecoverable, so BullMQ files it under `failed` without retrying", () => {
    const err = new UserNotifiedFailureError(new Error("boom"));
    expect(err).toBeInstanceOf(UnrecoverableError);
    expect(err.message).toContain("boom");
    expect(err.cause).toBeInstanceOf(Error);
  });

  it("TerminalNotifyError stays retryable: the user was NOT told, so it must not be unrecoverable", () => {
    expect(new TerminalNotifyError(new Error("send failed"))).not.toBeInstanceOf(UnrecoverableError);
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

  it("rejects with JobTimeoutError on schedule even when the handler ignores the abort signal", async () => {
    // A promise that never settles and never listens to `signal` — the shape of
    // a wedged socket or a parser stuck mid-file. If the deadline path awaited
    // the work, this test would hang until Jest's own timeout instead.
    const started = Date.now();

    await expect(runWithDeadline("job-hung", 40, () => new Promise<void>(() => {}))).rejects.toBeInstanceOf(
      JobTimeoutError
    );

    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(35);
    // Generous ceiling: the point is "about the deadline", not "never later".
    expect(elapsed).toBeLessThan(1_000);
  });
});
