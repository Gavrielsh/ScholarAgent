import { redactPhone } from "@/lib/security/auth";

describe("redactPhone", () => {
  it("keeps only the country-code prefix and the last two digits", () => {
    expect(redactPhone("972501234567")).toBe("972***67");
  });

  it("never echoes a short or malformed value back", () => {
    expect(redactPhone("1234")).toBe("****");
    expect(redactPhone("")).toBe("****");
  });

  it("does not contain the middle of the number, so a log line cannot identify the sender", () => {
    const masked = redactPhone("972541234567");
    expect(masked).not.toContain("412345");
    expect(masked.length).toBeLessThan("972541234567".length);
  });
});
