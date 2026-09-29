import superjson from "superjson";
import type { OutputType } from "./cart-context_GET.schema";
import { db } from "../../helpers/db";
import { cellarAccess } from "../../helpers/cellarAccess";
import { buildCatalog } from "../../helpers/wineCatalog";

const headers = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store, max-age=0",
  Pragma: "no-cache",
  Vary: "Cookie",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(superjson.stringify(body), { status, headers });
}

export async function handle(request: Request): Promise<Response> {
  try {
    const access = await cellarAccess.requireAccess(request);
    if (!access) return jsonResponse({ error: "Access required" }, 401);

    const [rows, contacts] = await Promise.all([
      db
        .selectFrom("wines")
        .leftJoin("wineStock", "wineStock.wineId", "wines.id")
        .leftJoin("locations", "locations.id", "wineStock.locationId")
        .select([
          "wines.id as id",
          "wines.producer as producer",
          "wines.wineName as wineName",
          "wines.vintage as vintage",
          "wines.country as country",
          "wines.region as region",
          "wines.subregion as subregion",
          "wines.appellation as appellation",
          "wines.grapeBlend as grapeBlend",
          "wines.colour as colour",
          "wines.wineStyle as wineStyle",
          "wines.sweetness as sweetness",
          "wines.bottleSizeMl as bottleSizeMl",
          "wines.photoPath as photoPath",
          "locations.id as locationId",
          "locations.fridge as fridge",
          "locations.shelf as shelf",
          "wineStock.quantity as quantity",
        ])
        .orderBy("wines.producer")
        .orderBy("wines.wineName")
        .orderBy("wines.id")
        .orderBy("locations.fridge")
        .orderBy("locations.shelf")
        .orderBy("locations.id")
        .execute(),
      db
        .selectFrom("contacts")
        .select(["id", "displayName", "isHost"])
        .where("active", "=", true)
        .orderBy("isHost", "desc")
        .orderBy("displayName")
        .orderBy("id")
        .execute(),
    ]);

    const principalId = access.role === "host" ? String(access.userId) : access.guestLinkId;
    const scope = `cart-v1:${cellarAccess.sha256Hex(JSON.stringify([access.role, principalId]))}`;
    const recipients = contacts.map((contact) => ({
      id: contact.id,
      displayName: contact.displayName,
      isHost: contact.isHost,
    }));
    const output: OutputType = {
      scope,
      role: access.role,
      wines: buildCatalog(rows),
      recipients,
      hostRecipientId: recipients.find((recipient) => recipient.isHost)?.id ?? null,
    };
    return jsonResponse(output);
  } catch {
    console.error("GET /cellar/cart-context failed");
    return jsonResponse({ error: "Unable to load cellar cart context" }, 500);
  }
}
