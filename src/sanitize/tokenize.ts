import { createHmac } from "node:crypto";

const TOKEN_HEX_LENGTH = 10;

/**
 * HMAC-SHA256, truncated, prefixed `TOK_` (ADR-0006). A function of the value and the salt
 * alone — never the path — so equal values collide into equal tokens across the whole corpus.
 */
export function tokenize(value: string, salt: Buffer): string {
  // ADR-0006: domain-separate every value so a token from this corpus cannot collide with
  // a token derived from the same value under a different scheme. Pure function of the value
  // and the salt alone — never the path — so equal values collide into equal tokens globally.
  const digest = createHmac("sha256", salt).update("trace-corpus-v1:" + value, "utf8").digest("hex");
  return `TOK_${digest.slice(0, TOKEN_HEX_LENGTH)}`;
}
