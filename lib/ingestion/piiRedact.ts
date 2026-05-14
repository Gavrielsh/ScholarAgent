// Best-effort PII masking before chunks are embedded or stored.
// Not a substitute for legal review — reduces accidental retention of raw identifiers.

const PHONE_IL = /(?:\+?972|0)(?:-?\d){8,9}\b/g;
const PHONE_GENERIC = /\b(?:\+?\d{1,3}[-.\s]?)?\(?\d{2,4}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g;
const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;

// Common Israeli school / org phrasing (very coarse — catches literal labels only).
const SCHOOL_LINE = /(?:^|\n)\s*(?:בית\s*ספר|תיכון|חטיבת?\s*ביניים|ישיבה)\s*[:\-]?\s*[^\n]{2,80}/gim;

export function redactPii(text: string): string {
  if (!text.trim()) return text;

  let out = text;
  out = out.replace(PHONE_IL, "[PHONE_REDACTED]");
  out = out.replace(PHONE_GENERIC, "[PHONE_REDACTED]");
  out = out.replace(EMAIL, "[EMAIL_REDACTED]");
  out = out.replace(SCHOOL_LINE, "[ORG_REDACTED]");

  // Mask sequences that look like Israeli national IDs (9 digits with optional dash).
  out = out.replace(/\b\d{1,3}-?\d{4}-?\d{4}\b/g, "[ID_REDACTED]");

  return out;
}
