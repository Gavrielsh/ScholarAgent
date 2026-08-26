import { whatsappIncomingJobId } from "@/lib/domain/whatsapp/queue/whatsappIncomingQueue";

describe("whatsappIncomingJobId", () => {
  it("never produces a colon, prefix included", () => {
    expect(whatsappIncomingJobId("wamid:with:colons")).not.toContain(":");
  });

  it("stays unique per message id", () => {
    expect(whatsappIncomingJobId("wamid.A")).toBe("wa_wamid.A");
    expect(whatsappIncomingJobId("wamid.A")).not.toBe(whatsappIncomingJobId("wamid.B"));
  });
});
