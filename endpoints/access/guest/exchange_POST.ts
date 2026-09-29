import { randomBytes } from "crypto";
import superjson from "superjson";
import { db } from "../../../helpers/db";
import { cellarAccess } from "../../../helpers/cellarAccess";
import { schema } from "./exchange_POST.schema";

const GuestSessionMs = 12 * 60 * 60 * 1000;
const json = (body: unknown, status = 200) => new Response(superjson.stringify(body), {
  status,
  headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
});

export async function handle(request: Request) {
  if (!cellarAccess.isSameOrigin(request)) return json({ message: "Request rejected" }, 403);

  let input: ReturnType<typeof schema.parse>;
  try {
    const body = await request.text();
    if (body.length > 512) return json({ message: "Invalid guest link" }, 400);
    input = schema.parse(superjson.parse(body));
  } catch {
    return json({ message: "Invalid guest link" }, 400);
  }
  if (!cellarAccess.isOpaqueToken(input.token)) return json({ message: "Invalid guest link" }, 400);

  const now = new Date();
  const sessionToken = randomBytes(32).toString("base64url");
  const sessionExpiresAt = new Date(now.getTime() + GuestSessionMs);
  const linkId = await db.transaction().execute(async (trx) => {
    const link = await trx
      .selectFrom("guestLinks")
      .select(["id", "revokedAt"])
      .where("tokenHash", "=", cellarAccess.sha256Hex(input.token))
      .forUpdate()
      .executeTakeFirst();
    if (!link || !cellarAccess.isGuestSessionActive(sessionExpiresAt, link.revokedAt, now)) {
      return null;
    }
    await trx.insertInto("guestSessions").values({
      id: cellarAccess.sha256Hex(sessionToken),
      guestLinkId: link.id,
      createdAt: now,
      expiresAt: sessionExpiresAt,
    }).execute();
    return link.id;
  });

  if (!linkId) return json({ message: "Guest link is invalid or closed" }, 403);
  const response = json({ role: "guest" });
  cellarAccess.setGuestCookie(response, sessionToken);
  return response;
}
