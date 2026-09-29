import { db } from "./db";
import { accessSecurity } from "./accessSecurity";
import { getServerSessionOrThrow } from "./getSetServerSession";

const GuestCookieName = "cellar_guest_session";
const GuestSessionSeconds = 60 * 60 * 12;

type HostPrincipal = { role: "host"; userId: number };
type GuestPrincipal = { role: "guest"; guestLinkId: string };
type AccessPrincipal = HostPrincipal | GuestPrincipal;

async function requireHost(request: Request): Promise<HostPrincipal | null> {
  let sessionId: string;
  try {
    const session = await getServerSessionOrThrow(request);
    sessionId = session.id;
  } catch {
    return null;
  }

  const now = new Date();
  const result = await db
    .selectFrom("sessions")
    .innerJoin("users", "sessions.userId", "users.id")
    .innerJoin(
      "cellarAccessSettings",
      "cellarAccessSettings.ownerUserId",
      "users.id",
    )
    .select([
      "users.id as userId",
      "users.role as role",
      "sessions.expiresAt as sessionExpiresAt",
      "cellarAccessSettings.ownerUserId as ownerUserId",
    ])
    .where("sessions.id", "=", sessionId)
    .limit(1)
    .executeTakeFirst();

  if (!result) return null;
  if (result.sessionExpiresAt <= now) return null;
  if (!accessSecurity.isHostIdentity(result.ownerUserId, result.userId, result.role)) {
    return null;
  }
  return { role: "host", userId: result.userId };
}

async function requireAccess(request: Request): Promise<AccessPrincipal | null> {
  const host = await requireHost(request);
  if (host) return host;

  const rawSession = accessSecurity.cookieValue(request, GuestCookieName);
  if (!rawSession || !accessSecurity.isOpaqueToken(rawSession)) return null;

  const now = new Date();
  const session = await db
    .selectFrom("guestSessions")
    .innerJoin("guestLinks", "guestSessions.guestLinkId", "guestLinks.id")
    .select([
      "guestLinks.id as guestLinkId",
      "guestSessions.expiresAt as sessionExpiresAt",
      "guestLinks.revokedAt as revokedAt",
    ])
    .where("guestSessions.id", "=", accessSecurity.sha256Hex(rawSession))
    .limit(1)
    .executeTakeFirst();

  if (
    !session ||
    !accessSecurity.isGuestSessionActive(
      session.sessionExpiresAt,
      session.revokedAt,
      now,
    )
  ) {
    return null;
  }
  return { role: "guest", guestLinkId: session.guestLinkId };
}

async function isDesignatedHostUser(userId: number): Promise<boolean> {
  const owner = await db
    .selectFrom("users")
    .innerJoin(
      "cellarAccessSettings",
      "cellarAccessSettings.ownerUserId",
      "users.id",
    )
    .select([
      "users.role as role",
      "cellarAccessSettings.ownerUserId as ownerUserId",
    ])
    .where("users.id", "=", userId)
    .where("cellarAccessSettings.id", "=", 1)
    .executeTakeFirst();

  return accessSecurity.isHostIdentity(
    owner?.ownerUserId ?? null,
    userId,
    owner?.role ?? "",
  );
}

function setGuestCookie(response: Response, rawSession: string): void {
  response.headers.set(
    "Set-Cookie",
    [
      `${GuestCookieName}=${encodeURIComponent(rawSession)}`,
      "HttpOnly",
      "Secure",
      "SameSite=Lax",
      "Path=/",
      `Max-Age=${GuestSessionSeconds}`,
    ].join("; "),
  );
}

function clearGuestCookie(response: Response): void {
  response.headers.append(
    "Set-Cookie",
    [
      `${GuestCookieName}=`,
      "HttpOnly",
      "Secure",
      "SameSite=Lax",
      "Path=/",
      "Max-Age=0",
    ].join("; "),
  );
}

export const cellarAccess = {
  requireHost,
  requireAccess,
  isDesignatedHostUser,
  isSameOrigin: accessSecurity.isSameOrigin,
  sha256Hex: accessSecurity.sha256Hex,
  isOpaqueToken: accessSecurity.isOpaqueToken,
  isGuestLinkActive: (...args: Parameters<typeof accessSecurity.isGuestLinkActive>) =>
    accessSecurity.isGuestLinkActive(...args),
  isGuestSessionActive: (...args: Parameters<typeof accessSecurity.isGuestSessionActive>) =>
    accessSecurity.isGuestSessionActive(...args),
  isBootstrapAvailable: (...args: Parameters<typeof accessSecurity.isBootstrapAvailable>) =>
    accessSecurity.isBootstrapAvailable(...args),
  cookieValue: accessSecurity.cookieValue,
  setGuestCookie,
  clearGuestCookie,
};
