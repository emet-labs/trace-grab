import { createHmac } from "node:crypto";

const TOKEN_HEX_LENGTH = 10;

/**
 * HMAC-SHA256, truncated, prefixed `TOK_` (ADR-0006). A function of the value and the salt
 * alone — never the path — so equal values collide into equal tokens across the whole corpus.
 */
export function tokenize(value: string, salt: Buffer): string {
  const digest = createHmac("sha256", salt).update(value, "utf8").digest("hex");
  return `TOK_${digest.slice(0, TOKEN_HEX_LENGTH)}`;
}
