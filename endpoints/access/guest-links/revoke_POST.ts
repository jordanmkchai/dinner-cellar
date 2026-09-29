import superjson from "superjson";
import { db } from "../../../helpers/db";
import { cellarAccess } from "../../../helpers/cellarAccess";
import { schema } from "./revoke_POST.schema";

const json = (body: unknown, status = 200) => new Response(superjson.stringify(body), {
  status,
  headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
});

export async function handle(request: Request) {
  if (!cellarAccess.isSameOrigin(request)) return json({ message: "Request rejected" }, 403);
  if (!(await cellarAccess.requireHost(request))) return json({ message: "Not authenticated" }, 401);

  let input: ReturnType<typeof schema.parse>;
  try {
    const body = await request.text();
    if (body.length > 256) return json({ message: "Invalid request" }, 400);
    input = schema.parse(superjson.parse(body));
  } catch {
    return json({ message: "Invalid request" }, 400);
  }

  const now = new Date();
  const success = await db.transaction().execute(async (trx) => {
    const link = await trx
      .updateTable("guestLinks")
      .set({ revokedAt: now })
      .where("id", "=", input.id)
      .where("revokedAt", "is", null)
      .returning("id")
      .executeTakeFirst();
    if (!link) return false;
    await trx.deleteFrom("guestSessions").where("guestLinkId", "=", link.id).execute();
    return true;
  });

  return json({ success });
}
