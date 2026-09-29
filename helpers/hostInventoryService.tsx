import type { CatalogWine } from "./wineCatalog";
import type { WineInput } from "./inventoryPolicy";
import type { QueryClient } from "@tanstack/react-query";
import { postUploadWinePhoto } from "./wineEntryService";
import { getInventoryOptions } from "../endpoints/cellar/inventory-options_GET.schema";
import { getHostInventory } from "../endpoints/host/inventory_GET.schema";
import type { HostContact } from "../endpoints/host/contacts_GET.schema";
import type { HostInventoryWine, HostStockRow } from "../endpoints/host/inventory_GET.schema";
import { getHostContacts } from "../endpoints/host/contacts_GET.schema";
import { postUpdateWine } from "../endpoints/host/wine-update_POST.schema";
import { postCorrectStock } from "../endpoints/host/stock-correct_POST.schema";
import { postMoveStock } from "../endpoints/host/stock-move_POST.schema";
import { postSaveContact } from "../endpoints/host/contact-save_POST.schema";

export const hostInventoryKeys = {
  checkouts: ["host-checkouts"] as const,
  receipt: ["checkout-receipt"] as const,
  cart: ["cart-context"] as const,
  inventory: ["host-inventory"] as const,
  contacts: ["host-contacts"] as const,
  options: ["inventory-options"] as const,
  catalog: ["wine-catalog"] as const,
  summary: ["cellar-summary"] as const,
};

export async function invalidateHostInventoryQueries(client: QueryClient): Promise<void> {
  await Promise.allSettled(Object.values(hostInventoryKeys).map((queryKey) => client.invalidateQueries({ queryKey })));
}

export function createHostOperationId(): string {
  return crypto.randomUUID();
}

export function wineInputFromCatalog(wine: CatalogWine): WineInput {
  return {
    producer: wine.producer,
    wineName: wine.wineName,
    vintage: wine.vintage,
    country: wine.country,
    region: wine.region,
    subregion: wine.subregion,
    appellation: wine.appellation,
    grapeBlend: wine.grapeBlend,
    colour: wine.colour,
    wineStyle: wine.wineStyle,
    sweetness: wine.sweetness,
    bottleSizeMl: wine.bottleSizeMl,
    // Omitted photoId keeps the existing photo on a metadata-only edit.
  };
}

export function hostErrorStatus(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("status" in error)) return undefined;
  const status = (error as { status?: unknown }).status;
  return typeof status === "number" ? status : undefined;
}

export function hostErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

export function hostErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim() ? error.message : fallback;
}

export {
  getHostInventory,
  getHostContacts,
  getInventoryOptions,
  postUploadWinePhoto,
  postUpdateWine,
  postCorrectStock,
  postMoveStock,
  postSaveContact,
};
export type { HostContact, HostInventoryWine, HostStockRow };
