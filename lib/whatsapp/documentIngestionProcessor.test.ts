import { resolveClassificationLevel } from "@/lib/whatsapp/documentIngestionProcessor";

describe("resolveClassificationLevel", () => {
  it("defaults to the manager tier when the caption carries no directive", () => {
    expect(resolveClassificationLevel(null, 0)).toBe(1);
    expect(resolveClassificationLevel("סיכום פעילות נובמבר", 0)).toBe(1);
  });

  it("honours an explicit directive in any of the accepted spellings", () => {
    expect(resolveClassificationLevel("#L3 חומרי הדרכה", 0)).toBe(3);
    expect(resolveClassificationLevel("level: 2", 0)).toBe(2);
    expect(resolveClassificationLevel("רמה 0", 0)).toBe(0);
  });

  it("never lets a sender classify above their own privilege", () => {
    // An L1 Manager asking for the admin-only tier is clamped back to L1.
    expect(resolveClassificationLevel("#L0", 1)).toBe(1);
    expect(resolveClassificationLevel(null, 1)).toBe(1);
  });
});
