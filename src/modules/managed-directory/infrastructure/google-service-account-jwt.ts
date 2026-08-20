import { createSign } from "node:crypto";

export interface GoogleServiceAccount {
  readonly clientEmail: string;
  readonly privateKey: string;
  readonly tokenUri: string;
}

export function parseGoogleServiceAccountJson(raw: string): GoogleServiceAccount | undefined {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (
      typeof parsed.client_email !== "string" ||
      typeof parsed.private_key !== "string" ||
      parsed.private_key.trim() === ""
    ) {
      return undefined;
    }
    return {
      clientEmail: parsed.client_email,
      privateKey: parsed.private_key.replace(/\\n/g, "\n"),
      tokenUri: typeof parsed.token_uri === "string" ? parsed.token_uri : "https://oauth2.googleapis.com/token",
    };
  } catch {
    return undefined;
  }
}

function base64Url(input: Buffer | string): string {
  const buffer = typeof input === "string" ? Buffer.from(input) : input;
  return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function createGoogleServiceAccountJwt(
  account: GoogleServiceAccount,
  scopes: readonly string[],
  subject: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): string {
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = base64Url(
    JSON.stringify({
      iss: account.clientEmail,
      scope: scopes.join(" "),
      aud: account.tokenUri,
      iat: nowSeconds,
      exp: nowSeconds + 3600,
      sub: subject,
    }),
  );
  const unsigned = `${header}.${claim}`;
  const signer = createSign("RSA-SHA256");
  signer.update(unsigned);
  const signature = base64Url(signer.sign(account.privateKey));
  return `${unsigned}.${signature}`;
}
