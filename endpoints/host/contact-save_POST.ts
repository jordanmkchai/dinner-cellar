import { sql } from "kysely";
import { schema } from "./contact-save_POST.schema";
import { parseHostBody, planContactDesignation } from "../../helpers/hostInventoryPolicy";
import { assertVersion, normalizeName, normalizePhone, PolicyError } from "../../helpers/inventoryPolicy";
import { inventoryError, inventoryJson, readInventoryBody, requireInventoryAccess, withInventoryOperation } from "../../helpers/inventoryServer";

export async function handle(request: Request): Promise<Response> {
  try {
    const principal = await requireInventoryAccess(request, true, true);
    const input = parseHostBody(schema, await readInventoryBody(request));
    const displayName = normalizeName(input.displayName);
    const phoneE164 = normalizePhone(input.phoneE164);
    const payload = {
      id: input.id,
      expectedVersion: input.expectedVersion,
      displayName,
      phoneE164,
      isHost: input.isHost,
      active: input.active,
    };
    const result = await withInventoryOperation(principal, input.operationId, "host.contact.save", payload, async (trx) => {
      await sql`select pg_advisory_xact_lock(hashtextextended('host-contact-designation', 0))`.execute(trx);
      const current = input.id
        ? await trx.selectFrom("contacts").select(["id", "isHost", "active", "version"]).where("id", "=", input.id).forUpdate().executeTakeFirst()
        : undefined;
      if (input.id && !current) throw new PolicyError("Contact not found", 404, "CONTACT_NOT_FOUND");
      if (current) assertVersion(String(current.version), input.expectedVersion ?? "");

      const host = await trx
        .selectFrom("contacts")
        .select(["id", "isHost"])
        .where("isHost", "=", true)
        .forUpdate()
        .executeTakeFirst();
      const designation = planContactDesignation({
        requestedIsHost: input.isHost,
        requestedActive: input.active,
        currentContactId: current?.id ?? null,
        currentContactIsHost: current?.isHost ?? false,
        currentHostId: host?.id ?? null,
      });

      const phoneMatch = input.id
        ? await trx.selectFrom("contacts").select("id").where("phoneE164", "=", phoneE164).where("id", "!=", input.id).executeTakeFirst()
        : await trx.selectFrom("contacts").select("id").where("phoneE164", "=", phoneE164).executeTakeFirst();
      if (phoneMatch) throw new PolicyError("That phone number is already saved to another contact", 409, "CONTACT_PHONE_IN_USE");

      if (designation.demoteHostId) {
        await trx
          .updateTable("contacts")
          .set({ isHost: false, version: sql`version + 1` })
          .where("id", "=", designation.demoteHostId)
          .execute();
      }

      if (current) {
        const updated = await trx
          .updateTable("contacts")
          .set({ displayName, phoneE164, isHost: input.isHost, active: input.active, version: sql`version + 1` })
          .where("id", "=", current.id)
          .returning("id")
          .executeTakeFirst();
        if (!updated) throw new PolicyError("Contact changed before save", 409, "VERSION_CONFLICT");
        return { contactId: updated.id };
      }

      const created = await trx
        .insertInto("contacts")
        .values({ displayName, phoneE164, isHost: input.isHost, active: input.active })
        .returning("id")
        .executeTakeFirstOrThrow();
      return { contactId: created.id };
    });
    return inventoryJson(result);
  } catch (error) {
    return inventoryError(error);
  }
}
