import superjson from "superjson";
import type { OutputType } from "./summary_GET.schema";
import { db } from "../../helpers/db";
import { cellarAccess } from "../../helpers/cellarAccess";
import { summarizeCellar } from "../../helpers/summarizeCellar";

const headers = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store, max-age=0",
  Pragma: "no-cache",
  Vary: "Cookie",
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(superjson.stringify(body), { status, headers });
}

export async function handle(request: Request): Promise<Response> {
  try {
    const access = await cellarAccess.requireAccess(request);
    if (!access) return jsonResponse({ error: "Access required" }, 401);

    const rows = await db
      .selectFrom("wineStock")
      .innerJoin("wines", "wines.id", "wineStock.wineId")
      .innerJoin("locations", "locations.id", "wineStock.locationId")
      .select([
        "wineStock.wineId",
        "wines.photoPath",
        "wineStock.quantity",
        "locations.fridge",
        "locations.shelf",
      ])
      .where("wineStock.quantity", ">", 0)
      .orderBy("locations.fridge")
      .orderBy("locations.shelf")
      .orderBy("wineStock.wineId")
      .execute();

    return jsonResponse({ role: access.role, ...summarizeCellar(rows) } satisfies OutputType);
  } catch (error) {
    console.error("GET /cellar/summary failed", error);
    return jsonResponse({ error: "Unable to load cellar summary" }, 500);
  }
}
