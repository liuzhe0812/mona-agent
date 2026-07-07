/**
 * Decode IMAP Modified UTF-7 folder names (RFC 3501 Section 5.1.3).
 *
 * IMAP servers return folder names containing non-ASCII characters as
 * `&...-` segments. Modified BASE64 uses `,` instead of standard `/`.
 * Returns the input unchanged if decoding fails.
 */
export function decodeImapUtf7(input: string): string {
  let result = "";
  let i = 0;
  while (i < input.length) {
    if (input[i] === "&") {
      const j = input.indexOf("-", i + 1);
      if (j === -1) {
        result += input[i];
        i += 1;
        continue;
      }
      const encoded = input.slice(i + 1, j);
      if (encoded === "") {
        // "&-" represents a literal ampersand.
        result += "&";
      } else {
        try {
          const normalized = encoded.replace(/,/g, "/");
          const padded = normalized.padEnd(
            normalized.length + ((4 - (normalized.length % 4)) % 4),
            "=",
          );
          const raw = Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
          let decoded = "";
          for (let k = 0; k + 1 < raw.length; k += 2) {
            decoded += String.fromCharCode(
              (raw[k] << 8) | raw[k + 1],
            );
          }
          result += decoded;
        } catch {
          result += input.slice(i, j + 1);
        }
      }
      i = j + 1;
    } else {
      result += input[i];
      i += 1;
    }
  }
  return result;
}
