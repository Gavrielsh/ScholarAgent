import { parseInboundDocumentEvent, parseInboundEvent } from "@/lib/whatsapp/parseWebhook";
import type { WhatsAppWebhookPayload } from "@/lib/whatsapp/types";

function payload(message: Record<string, unknown>): WhatsAppWebhookPayload {
  return {
    entry: [{ changes: [{ value: { messages: [message as never] } }] }],
  };
}

const documentMessage = {
  from: "972500000000",
  id: "wamid.DOC1",
  type: "document",
  document: {
    id: "media-123",
    mime_type: "application/pdf",
    filename: "activity.pdf",
    sha256: "abc123",
    caption: "פעילות חדשה",
  },
};

describe("parseInboundDocumentEvent", () => {
  it("extracts the media id, mime type, filename and caption", () => {
    expect(parseInboundDocumentEvent(payload(documentMessage))).toEqual({
      senderId: "972500000000",
      messageId: "wamid.DOC1",
      mediaId: "media-123",
      mimeType: "application/pdf",
      filename: "activity.pdf",
      caption: "פעילות חדשה",
      sha256: "abc123",
    });
  });

  it("normalises a parameterised mime type to the extractor key", () => {
    const event = parseInboundDocumentEvent(
      payload({
        ...documentMessage,
        document: { ...documentMessage.document, mime_type: "TEXT/PLAIN; charset=utf-8" },
      })
    );
    expect(event?.mimeType).toBe("text/plain");
  });

  it("falls back to a safe filename and strips path separators", () => {
    const event = parseInboundDocumentEvent(
      payload({
        ...documentMessage,
        document: { ...documentMessage.document, filename: "../../etc/passwd" },
      })
    );
    expect(event?.filename).toBe(".._.._etc_passwd");

    const unnamed = parseInboundDocumentEvent(
      payload({
        ...documentMessage,
        document: { id: "media-123", mime_type: "application/pdf" },
      })
    );
    expect(unnamed?.filename).toBe("document.pdf");
    expect(unnamed?.caption).toBeNull();
  });

  it("declines a document with no media id, and every non-document message", () => {
    expect(
      parseInboundDocumentEvent(
        payload({ ...documentMessage, document: { mime_type: "application/pdf" } })
      )
    ).toBeNull();

    expect(
      parseInboundDocumentEvent(
        payload({ from: "972500000000", id: "wamid.TXT", type: "text", text: { body: "שלום" } })
      )
    ).toBeNull();
  });

  it("leaves the chat parser untouched — a document never becomes a chat turn", () => {
    expect(parseInboundEvent(payload(documentMessage))).toBeNull();
    expect(
      parseInboundEvent(
        payload({ from: "972500000000", id: "wamid.TXT", type: "text", text: { body: "שלום" } })
      )
    ).toEqual({ senderId: "972500000000", messageId: "wamid.TXT", messageBody: "שלום" });
  });
});
