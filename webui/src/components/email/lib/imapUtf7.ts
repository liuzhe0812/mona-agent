/**
 * Decode IMAP modified UTF-7 folder names (RFC 3501) to a human-readable string.
 *
 * Examples:
 *   "INBOX" -> "INBOX"
 *   "&g0l6P3ux-" -> "Sent Messages"
 *   "&XfJSIJZk-" -> "Drafts"
 *   "&-" -> "&"
 */

export function decodeImapUtf7(input: string): string {
  return input.replace(/&([^-]*)-/g, (_, seq: string) => {
    if (seq === "") return "&";
    try {
      // Modified UTF-7 uses ',' instead of '/' for base64
      const b64 = seq.replace(/,/g, "/");
      const pad = (4 - (b64.length % 4)) % 4;
      const padded = b64 + "=".repeat(pad);
      const binary = atob(padded);
      const codes: number[] = [];
      for (let i = 0; i < binary.length; i += 2) {
        codes.push((binary.charCodeAt(i) << 8) | binary.charCodeAt(i + 1));
      }
      return String.fromCharCode(...codes);
    } catch {
      // If decoding fails, leave the original sequence as-is
      return `&${seq}-`;
    }
  });
}
