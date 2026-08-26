import { documentIngestionJobId } from "@/lib/domain/ingestion/queue/documentIngestionQueue";

describe("documentIngestionJobId", () => {
  // BullMQ's Queue.add throws `Custom Id cannot contain :`, which surfaced as a
  // 503 from the webhook and a Meta redelivery loop rather than as a test
  // failure. The prefix is the part that got this wrong originally.
  it("never produces a colon, prefix included", () => {
    const realWorldId = "wamid.HBgMOTcyNTQzMTMzMjkyFQIAEhgUM0EzREVEMjQ3RkRDMDY0NUQ5MkEA";
    expect(documentIngestionJobId(realWorldId)).not.toContain(":");
    expect(documentIngestionJobId("wamid:with:colons")).not.toContain(":");
  });

  it("stays unique per message id, so BullMQ dedupes redeliveries", () => {
    expect(documentIngestionJobId("wamid.A")).toBe("doc_wamid.A");
    expect(documentIngestionJobId("wamid.A")).toBe(documentIngestionJobId("wamid.A"));
    expect(documentIngestionJobId("wamid.A")).not.toBe(documentIngestionJobId("wamid.B"));
  });
});
