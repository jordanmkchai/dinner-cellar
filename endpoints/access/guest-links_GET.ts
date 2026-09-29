import superjson from "superjson";
import { db } from "../../helpers/db";
import { cellarAccess } from "../../helpers/cellarAccess";

const json = (body: unknown, status = 200) => new Response(superjson.stringify(body), {
  status,
  headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
});

export async function handle(request: Request) {
  if (!(await cellarAccess.requireHost(request))) return json({ message: "Not authenticated" }, 401);
  const rows = await db
    .selectFrom("guestLinks")
    .select(["id", "createdAt", "revokedAt"])
    .orderBy("createdAt", "desc")
    .limit(100)
    .execute();
  return json({
    links: rows.map((row) => ({
      id: row.id,
      createdAt: row.createdAt.toISOString(),
      revokedAt: row.revokedAt?.toISOString() ?? null,
      active: cellarAccess.isGuestLinkActive(row.revokedAt),
    })),
  });
}
