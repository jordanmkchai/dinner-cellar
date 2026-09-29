import { randomBytes } from "crypto";
import { sql } from "kysely";
import superjson from "superjson";
import { db } from "../../helpers/db";
import { cellarAccess } from "../../helpers/cellarAccess";
import { generatePasswordHash } from "../../helpers/generatePasswordHash";
import { SessionExpirationSeconds, setServerSession } from "../../helpers/getSetServerSession";
import { schema } from "./setup_POST.schema";

const json = (body: unknown, status = 200) => new Response(superjson.stringify(body), {
  status,
  headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
});

export async function handle(request: Request) {
  if (!cellarAccess.isSameOrigin(request)) return json({ message: "Request rejected" }, 403);
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
    return json({ message: "Invalid setup details" }, 400);
  }

  let input: ReturnType<typeof schema.parse>;
  try {
    const body = await request.text();
    if (body.length > 4096) return json({ message: "Invalid setup details" }, 400);
    input = schema.parse(superjson.parse(body));
  } catch {
    return json({ message: "Invalid setup details" }, 400);
  }

  const now = new Date();
  if (!cellarAccess.isOpaqueToken(input.token)) return json({ message: "Invalid setup details" }, 400);
  const candidateHash = cellarAccess.sha256Hex(input.token);
  const sessionId = randomBytes(32).toString("hex");

  const candidateSettings = await db
    .selectFrom("cellarAccessSettings")
    .select(["ownerUserId", "bootstrapTokenHash", "bootstrapExpiresAt", "bootstrapUsedAt"])
    .where("id", "=", 1)
    .executeTakeFirst();
  if (!candidateSettings || !cellarAccess.isBootstrapAvailable(
    candidateSettings.ownerUserId,
    candidateSettings.bootstrapUsedAt,
    candidateSettings.bootstrapExpiresAt,
    candidateSettings.bootstrapTokenHash,
    candidateHash,
    now,
  )) return json({ message: "Setup code is invalid, expired, or already used" }, 403);

  const passwordHash = await generatePasswordHash(input.password);

  let result: {
    type: "success";
    createdAt: Date;
    user: { id: number; email: string; displayName: string; avatarUrl: string | null; role: "admin" };
  } | { type: "invalid" } | { type: "email_taken" };
  try {
    result = await db.transaction().execute(async (trx) => {
      const settings = await trx
        .selectFrom("cellarAccessSettings")
        .select(["ownerUserId", "bootstrapTokenHash", "bootstrapExpiresAt", "bootstrapUsedAt"])
        .where("id", "=", 1)
        .forUpdate()
        .executeTakeFirst();
      const claimTime = new Date();

      if (!settings || !cellarAccess.isBootstrapAvailable(
        settings.ownerUserId,
        settings.bootstrapUsedAt,
        settings.bootstrapExpiresAt,
        settings.bootstrapTokenHash,
        candidateHash,
        claimTime,
      )) return { type: "invalid" as const };

      const existing = await trx
        .selectFrom("users")
        .select("id")
        .where(sql<string>`LOWER(email)`, "=", input.email)
        .limit(1)
        .executeTakeFirst();
      if (existing) return { type: "email_taken" as const };

      const user = await trx
        .insertInto("users")
        .values({ email: input.email, displayName: input.displayName, avatarUrl: null, role: "admin" })
        .returning(["id", "email", "displayName", "avatarUrl", "role"])
        .executeTakeFirstOrThrow();

      await trx.insertInto("userPasswords").values({ userId: user.id, passwordHash }).execute();
      const sessionExpiresAt = new Date(claimTime.getTime() + SessionExpirationSeconds * 1000);
      await trx.insertInto("sessions").values({
        id: sessionId,
        userId: user.id,
        createdAt: claimTime,
        lastAccessed: claimTime,
        expiresAt: sessionExpiresAt,
      }).execute();

      const updated = await trx
        .updateTable("cellarAccessSettings")
        .set({ ownerUserId: user.id, bootstrapUsedAt: claimTime })
        .where("id", "=", 1)
        .where("ownerUserId", "is", null)
        .where("bootstrapUsedAt", "is", null)
        .where("bootstrapExpiresAt", ">", claimTime)
        .where("bootstrapTokenHash", "=", settings.bootstrapTokenHash)
        .returning("id")
        .executeTakeFirst();
      if (!updated) throw new Error("bootstrap claim lost");

      return {
        type: "success" as const,
        createdAt: claimTime,
        user: {
          id: user.id,
          email: user.email,
          displayName: user.displayName,
          avatarUrl: user.avatarUrl,
          role: "admin" as const,
        },
      };
    });
  } catch {
    return json({ message: "Setup could not be completed" }, 500);
  }

  if (result.type === "invalid") return json({ message: "Setup code is invalid, expired, or already used" }, 403);
  if (result.type === "email_taken") return json({ message: "Email already in use" }, 409);

  const response = json({ user: result.user });
  await setServerSession(response, {
    id: sessionId,
    createdAt: result.createdAt.getTime(),
    lastAccessed: result.createdAt.getTime(),
  });
  return response;
}
