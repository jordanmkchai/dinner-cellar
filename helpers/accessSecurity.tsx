import { createHash, timingSafeEqual } from "crypto";

type TimestampValue = Date | string;

function timestamp(value: TimestampValue): number {
  return value instanceof Date ? value.getTime() : Date.parse(value);
}

function validHash(value: string): boolean {
  return /^[a-f0-9]{64}$/.test(value);
}

function isGuestLinkActive(revokedAt: TimestampValue | null): boolean {
  return revokedAt === null;
}

function hashesMatch(storedHash: string, candidateHash: string): boolean {
  if (!validHash(storedHash) || !validHash(candidateHash)) return false;
  return timingSafeEqual(
    Buffer.from(storedHash, "hex"),
    Buffer.from(candidateHash, "hex"),
  );
}

export const accessSecurity = {
  sha256Hex(value: string): string {
    return createHash("sha256").update(value, "utf8").digest("hex");
  },

  isOpaqueToken(value: string): boolean {
    if (!/^[A-Za-z0-9_-]{43}$/.test(value)) return false;
    const decoded = Buffer.from(value, "base64url");
    return decoded.length === 32 && decoded.toString("base64url") === value;
  },

  isHostIdentity(ownerUserId: number | null, userId: number, role: string): boolean {
    return ownerUserId !== null && ownerUserId === userId && role === "admin";
  },

  isGuestLinkActive(revokedAt: TimestampValue | null): boolean {
    return isGuestLinkActive(revokedAt);
  },

  isGuestSessionActive(
    sessionExpiresAt: TimestampValue,
    revokedAt: TimestampValue | null,
    now: Date = new Date(),
  ): boolean {
    const sessionExpires = timestamp(sessionExpiresAt);
    return (
      isGuestLinkActive(revokedAt) &&
      Number.isFinite(sessionExpires) &&
      sessionExpires > now.getTime()
    );
  },

  hashesMatch(storedHash: string, candidateHash: string): boolean {
    return hashesMatch(storedHash, candidateHash);
  },

  isBootstrapAvailable(
    ownerUserId: number | null,
    usedAt: TimestampValue | null,
    expiresAt: TimestampValue,
    storedHash: string,
    candidateHash: string,
    now: Date = new Date(),
  ): boolean {
    const expires = timestamp(expiresAt);
    return (
      ownerUserId === null &&
      usedAt === null &&
      Number.isFinite(expires) &&
      expires > now.getTime() &&
      hashesMatch(storedHash, candidateHash)
    );
  },

  isSameOrigin(request: Request): boolean {
    const origin = request.headers.get("origin");
    if (!origin || origin === "null") return false;
    try {
      return new URL(request.url).origin === origin;
    } catch {
      return false;
    }
  },

  cookieValue(request: Request, name: string): string | null {
    const header = request.headers.get("cookie");
    if (!header) return null;

    let found: string | null = null;
    for (const part of header.split(";")) {
      const separator = part.indexOf("=");
      if (separator < 0) continue;
      if (part.slice(0, separator).trim() !== name) continue;
      if (found !== null) return null;
      try {
        found = decodeURIComponent(part.slice(separator + 1).trim());
      } catch {
        return null;
      }
    }
    return found;
  },
};
