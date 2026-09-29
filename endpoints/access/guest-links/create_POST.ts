import { randomBytes } from "crypto";
import superjson from "superjson";
import { db } from "../../../helpers/db";
import { cellarAccess } from "../../../helpers/cellarAccess";
import { schema } from "./create_POST.schema";

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

  const token = randomBytes(32).toString("base64url");
  const row = await db
    .insertInto("guestLinks")
    .values({ tokenHash: cellarAccess.sha256Hex(token) })
    .returning(["id"])
    .executeTakeFirstOrThrow();

  return json({
    link: {
      id: row.id,
      path: `/join#token=${token}`,
    },
  });
}
