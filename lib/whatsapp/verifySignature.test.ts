import {
  isWebhookSignatureRequired,
  verifyMetaSignature,
} from "@/lib/whatsapp/verifySignature";

describe("isWebhookSignatureRequired", () => {
  const original = {
    VERCEL: process.env.VERCEL,
    REQUIRE_WEBHOOK_SIGNATURE: process.env.REQUIRE_WEBHOOK_SIGNATURE,
  };

  afterEach(() => {
    if (original.VERCEL === undefined) {
      delete process.env.VERCEL;
    } else {
      process.env.VERCEL = original.VERCEL;
    }
    if (original.REQUIRE_WEBHOOK_SIGNATURE === undefined) {
      delete process.env.REQUIRE_WEBHOOK_SIGNATURE;
    } else {
      process.env.REQUIRE_WEBHOOK_SIGNATURE = original.REQUIRE_WEBHOOK_SIGNATURE;
    }
  });

  it("can be forced on via REQUIRE_WEBHOOK_SIGNATURE", () => {
    delete process.env.VERCEL;
    process.env.REQUIRE_WEBHOOK_SIGNATURE = "1";
    expect(isWebhookSignatureRequired()).toBe(true);
  });

  it("is required when VERCEL=1", () => {
    delete process.env.REQUIRE_WEBHOOK_SIGNATURE;
    process.env.VERCEL = "1";
    expect(isWebhookSignatureRequired()).toBe(true);
  });
});

describe("verifyMetaSignature", () => {
  const originalSecret = process.env.WHATSAPP_APP_SECRET;

  afterEach(() => {
    if (originalSecret === undefined) {
      delete process.env.WHATSAPP_APP_SECRET;
    } else {
      process.env.WHATSAPP_APP_SECRET = originalSecret;
    }
  });

  it("returns unconfigured when the app secret is missing", () => {
    delete process.env.WHATSAPP_APP_SECRET;
    expect(verifyMetaSignature("{}", null)).toBe("unconfigured");
  });

  it("returns invalid when the header is missing", () => {
    process.env.WHATSAPP_APP_SECRET = "test-secret";
    expect(verifyMetaSignature("{}", null)).toBe("invalid");
  });
});
