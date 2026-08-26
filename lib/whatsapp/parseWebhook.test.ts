import {
  parseInboundDelivery,
  parseInboundDocumentEvent,
  parseInboundEvent,
  peekInboundMessageType,
} from "@/lib/whatsapp/parseWebhook";
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

describe("parseInboundDelivery", () => {
  it("routes type 'document' to the document-ingestion queue", () => {
    const delivery = parseInboundDelivery(payload(documentMessage));
    expect(delivery?.kind).toBe("document");
    expect(delivery?.event).toMatchObject({ mediaId: "media-123", mimeType: "application/pdf" });
  });

  it("routes text and interactive replies to the chat queue", () => {
    expect(
      parseInboundDelivery(
        payload({ from: "972500000000", id: "wamid.TXT", type: "text", text: { body: "שלום" } })
      )?.kind
    ).toBe("chat");

    expect(
      parseInboundDelivery(
        payload({
          from: "972500000000",
          id: "wamid.BTN",
          type: "interactive",
          interactive: { type: "button_reply", button_reply: { id: "menu_1", title: "היסטוריה" } },
        })
      )?.kind
    ).toBe("chat");

    expect(
      parseInboundDelivery(
        payload({
          from: "972500000000",
          id: "wamid.LIST",
          type: "interactive",
          interactive: { type: "list_reply", list_reply: { id: "l0_daily_summary", title: "סיכום יומי" } },
        })
      )
    ).toEqual({
      kind: "chat",
      event: {
        senderId: "972500000000",
        messageId: "wamid.LIST",
        messageBody: "סיכום יומי",
        buttonId: "l0_daily_summary",
      },
    });

    expect(
      parseInboundDelivery(
        payload({
          from: "972500000000",
          id: "wamid.QUICK",
          type: "button",
          button: { payload: "l0_specific_user", text: "משתמש ספציפי" },
        })
      )
    ).toEqual({
      kind: "chat",
      event: {
        senderId: "972500000000",
        messageId: "wamid.QUICK",
        messageBody: "משתמש ספציפי",
        buttonId: "l0_specific_user",
      },
    });
  });

  it("refuses to downgrade an unusable document into a chat turn", () => {
    // No media id: the job could do no work, but answering it with the LLM
    // would be worse — the admin would get a chat reply to a file upload.
    expect(
      parseInboundDelivery(
        payload({ ...documentMessage, document: { mime_type: "application/pdf" } })
      )
    ).toBeNull();
  });

  it("reports the observed type for message kinds no queue owns", () => {
    const image = payload({ from: "972500000000", id: "wamid.IMG", type: "image" });
    expect(parseInboundDelivery(image)).toBeNull();
    expect(peekInboundMessageType(image)).toBe("image");
  });
});
