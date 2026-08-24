/** WhatsApp Cloud API hard limit for a text body. */
export const WHATSAPP_TEXT_CHAR_LIMIT = 4096;

/**
 * Normalises LLM output for WhatsApp delivery.
 *
 * WhatsApp renders bold as single asterisks (*bold*); the Markdown-style double
 * asterisk (**bold**) leaks through as literal characters. The system directives
 * ask the model for single asterisks, but this is the deterministic backstop for
 * when it ignores them.
 */
export function formatWhatsAppMarkdown(text: string): string {
  return text.replace(/\*\*/g, "*").trim();
}

/**
 * Splits `text` into pieces that each fit `limit`, preferring newline then
 * space so a user-table row is not cut mid-line.
 */
export function chunkWhatsAppText(text: string, limit = WHATSAPP_TEXT_CHAR_LIMIT): string[] {
  if (text.length <= limit) return [text];

  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= limit) {
      chunks.push(remaining);
      break;
    }

    let splitAt = remaining.lastIndexOf("\n", limit);
    if (splitAt <= 0) {
      splitAt = remaining.lastIndexOf(" ", limit);
    }
    if (splitAt <= 0) {
      splitAt = limit;
    }

    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).replace(/^\n/, "");
  }
  return chunks;
}
