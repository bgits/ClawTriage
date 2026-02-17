import crypto from "node:crypto";

export function verifyWebhookSignature(params: {
  rawBody: Buffer;
  signatureHeader: string | undefined;
  secret: string;
}): boolean {
  const { rawBody, signatureHeader, secret } = params;
  if (!signatureHeader || !signatureHeader.startsWith("sha256=")) {
    return false;
  }

  const expected = `sha256=${crypto
    .createHmac("sha256", secret)
    .update(rawBody)
    .digest("hex")}`;

  const actualBuffer = Buffer.from(signatureHeader, "utf8");
  const expectedBuffer = Buffer.from(expected, "utf8");

  if (actualBuffer.length !== expectedBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}
