import { parseL0MenuChoice } from "@/lib/agent/baseline/chatHistoryHandlers";

describe("parseL0MenuChoice", () => {
  it("maps typed 1/2, titles, and button ids to daily/specific", () => {
    expect(parseL0MenuChoice("1")).toBe("daily");
    expect(parseL0MenuChoice("1.")).toBe("daily");
    expect(parseL0MenuChoice("2")).toBe("specific");
    expect(parseL0MenuChoice("2)")).toBe("specific");
    expect(parseL0MenuChoice("סיכום יומי")).toBe("daily");
    expect(parseL0MenuChoice("משתמש ספציפי")).toBe("specific");
    expect(parseL0MenuChoice("1. Daily summary")).toBe("daily");
    expect(parseL0MenuChoice("2. Specific user")).toBe("specific");
    expect(parseL0MenuChoice("", "l0_daily_summary")).toBe("daily");
    expect(parseL0MenuChoice("", "l0_specific_user")).toBe("specific");
  });

  it("treats bare cancel words as exit and ignores unrelated text", () => {
    expect(parseL0MenuChoice("ביטול")).toBe("cancel");
    expect(parseL0MenuChoice("cancel")).toBe("cancel");
    expect(parseL0MenuChoice("חזור")).toBe("cancel");
    expect(parseL0MenuChoice("מה מזג האוויר")).toBeNull();
    expect(parseL0MenuChoice("12")).toBeNull();
  });
});
