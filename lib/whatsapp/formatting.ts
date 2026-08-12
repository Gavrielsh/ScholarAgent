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
