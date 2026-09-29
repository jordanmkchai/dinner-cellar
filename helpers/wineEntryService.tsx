import superjson from "superjson";
import { postAddWine } from "../endpoints/cellar/wine-add_POST.schema";
import { postRestockWine } from "../endpoints/cellar/wine-restock_POST.schema";
import type { InputType as RestockInput, OutputType as RestockOutput } from "../endpoints/cellar/wine-restock_POST.schema";
import type { OutputType as AddOutput } from "../endpoints/cellar/wine-add_POST.schema";
import type { OutputType as CatalogOutput } from "../endpoints/cellar/catalog_GET.schema";
import type { OutputType as OptionsOutput } from "../endpoints/cellar/inventory-options_GET.schema";
import type { CatalogWine } from "./wineCatalog";
import { clearPhotoOperationId, clearPhotoOperationIfExpired, photoOperationIdFor, postUploadWinePhotoDirect } from "./photoUploadClient";

export type EntryRequestError = Error & {
  status?: number;
  code?: string;
  uncertain: boolean;
};

function requestError(message: string, status?: number, code?: string): EntryRequestError {
  const error = new Error(message) as EntryRequestError;
  error.status = status;
  error.code = code;
  error.uncertain = status === undefined || status >= 500;
  return error;
}

async function readWirePayload<T>(response: Response): Promise<T | null> {
  try {
    const text = await response.text();
    return text ? superjson.parse<T>(text) : null;
  } catch {
    return null;
  }
}

export async function getInventoryOptions(): Promise<OptionsOutput> {
  let response: Response;
  try {
    response = await fetch("/_api/cellar/inventory-options", {
      method: "GET",
      cache: "no-store",
      credentials: "include",
    });
  } catch {
    throw requestError("Inventory options could not be reached");
  }
  const payload = await readWirePayload<OptionsOutput | { code?: string; message?: string }>(response);
  if (!response.ok) {
    throw requestError(
      payload && "message" in payload && payload.message ? payload.message : "Inventory options are unavailable",
      response.status,
      payload && "code" in payload ? payload.code : undefined,
    );
  }
  if (!payload || !("categories" in payload) || !Array.isArray(payload.locations)) {
    throw requestError("Inventory options response was incomplete", response.status);
  }
  return payload as OptionsOutput;
}

function photoOperationId(file: File): string {
  return photoOperationIdFor(file, () => {
    if (typeof crypto === "undefined" || typeof crypto.randomUUID !== "function") return "";
    return crypto.randomUUID();
  });
}

export async function postUploadWinePhoto(file: File, init?: RequestInit): Promise<{ id: string; photoPath: string }> {
  const operationId = photoOperationId(file);
  try {
    const result = await postUploadWinePhotoDirect(file, operationId, {
      fetcher: fetch,
      encodeJson: (value) => superjson.stringify(value),
      decodeJson: async (response) => superjson.parse<unknown>(await response.text()),
      decodeError: async (response) => {
        const payload = await readWirePayload<{ message?: string; code?: string }>(response);
        return { message: payload?.message, code: payload?.code };
      },
    }, init?.signal ?? undefined);
    clearPhotoOperationId(file);
    return result;
  } catch (error) {
    clearPhotoOperationIfExpired(file, error);
    throw error;
  }
}

export async function refreshEntryCatalog(): Promise<CatalogWine[] | null> {
  let response: Response;
  try {
    response = await fetch("/_api/cellar/catalog", {
      method: "GET",
      cache: "no-store",
      credentials: "include",
    });
  } catch {
    throw requestError("Wine catalog could not be refreshed");
  }
  const payload = await readWirePayload<CatalogOutput | { code?: string; message?: string }>(response);
  if (response.status === 401 || response.status === 403) return null;
  if (!response.ok) {
    throw requestError(
      payload && "message" in payload && payload.message ? payload.message : "Wine catalog is unavailable",
      response.status,
      payload && "code" in payload ? payload.code : undefined,
    );
  }
  if (!payload || !("wines" in payload) || !Array.isArray(payload.wines)) {
    throw requestError("Wine catalog response was incomplete", response.status);
  }
  return (payload as CatalogOutput).wines;
}

export { postAddWine, postRestockWine };
export type { AddOutput, RestockInput, RestockOutput };
