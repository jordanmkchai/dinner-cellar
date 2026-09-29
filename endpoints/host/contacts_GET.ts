import { db } from "../../helpers/db";
import { inventoryError, inventoryJson, requireInventoryAccess } from "../../helpers/inventoryServer";

export async function handle(request: Request): Promise<Response> {
  try {
    await requireInventoryAccess(request, true, false);
    const rows = await db
      .selectFrom("contacts")
      .select(["id", "displayName", "phoneE164", "isHost", "active", "version"])
      .orderBy("active", "desc")
      .orderBy("isHost", "desc")
      .orderBy("displayName")
      .orderBy("id")
      .execute();
    return inventoryJson({ contacts: rows.map((row) => ({ ...row, version: String(row.version) })) });
  } catch (error) {
    return inventoryError(error);
  }
}
