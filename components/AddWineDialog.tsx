import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { resetPrivateCart } from "../helpers/cartStore";
import { WineFields } from "./WineFields";
import type { CatalogWine } from "../helpers/wineCatalog";
import { emptyWineInput, normalizeWineInput, normalizedWineIdentity, quantity as normalizeQuantity } from "../helpers/inventoryPolicy";
import type { WineInput } from "../helpers/inventoryPolicy";
import {
  getInventoryOptions,
  postAddWine,
  postRestockWine,
  postUploadWinePhoto,
  refreshEntryCatalog,
} from "../helpers/wineEntryService";
import type { EntryRequestError } from "../helpers/wineEntryService";
import type { OutputType as InventoryOptions } from "../endpoints/cellar/inventory-options_GET.schema";
import styles from "./AddWineDialog.module.css";

type Mode = "new" | "restock";
type DialogDraft = {
  mode: Mode;
  wine: WineInput;
  contributorName: string;
  fridge: string;
  shelf: string;
  quantityText: string;
  selectedWineId: string;
  createSeparate: boolean;
  photoFile: File | null;
  uploadedPhotoId: string | null;
};
type FrozenOperation =
  | { kind: "add"; payload: Parameters<typeof postAddWine>[0] }
  | { kind: "restock"; payload: Parameters<typeof postRestockWine>[0] };

const MAX_PHOTO_BYTES = 5 * 1024 * 1024;
const ALLOWED_PHOTO_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

function newOperationId(): string {
  return crypto.randomUUID();
}

function emptyDraft(): DialogDraft {
  return {
    mode: "new",
    wine: emptyWineInput(),
    contributorName: "",
    fridge: "",
    shelf: "",
    quantityText: "1",
    selectedWineId: "",
    createSeparate: false,
    photoFile: null,
    uploadedPhotoId: null,
  };
}

function wineTitle(wine: Pick<CatalogWine, "producer" | "wineName" | "vintage" | "bottleSizeMl">): string {
  return `${wine.producer} — ${wine.wineName}${wine.vintage ? ` (${wine.vintage})` : ""} · ${wine.bottleSizeMl} ml`;
}

function isAccessDenied(error: unknown): boolean {
  return (error as EntryRequestError | undefined)?.status === 401 || (error as EntryRequestError | undefined)?.status === 403;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

export type AddWineDialogProps = {
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
  wines: CatalogWine[];
};

export const AddWineDialog: React.FC<AddWineDialogProps> = ({ open, onClose, onSaved, wines }) => {
  const queryClient = useQueryClient();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const operationIdRef = useRef(newOperationId());
  const onCloseRef = useRef(onClose);
  const onSavedRef = useRef(onSaved);
  const [draft, setDraft] = useState<DialogDraft>(emptyDraft);
  const [options, setOptions] = useState<InventoryOptions | null>(null);
  const [optionsLoading, setOptionsLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [uncertainOperation, setUncertainOperation] = useState<FrozenOperation | null>(null);
  const [refreshedWines, setRefreshedWines] = useState<CatalogWine[] | null>(null);
  const [serverMatchConflict, setServerMatchConflict] = useState(false);
  const [success, setSuccess] = useState<string | null>(null);

  onCloseRef.current = onClose;
  onSavedRef.current = onSaved;
  const availableWines = refreshedWines ?? wines;

  const matchingWines = useMemo(() => {
    if (draft.mode !== "new") return [];
    try {
      const normalized = normalizeWineInput(draft.wine);
      const identity = normalizedWineIdentity(normalized);
      return availableWines.filter((wine) => normalizedWineIdentity({
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
      }) === identity);
    } catch {
      return [];
    }
  }, [availableWines, draft.mode, draft.wine]);

  const selectedFileUrl = useMemo(
    () => draft.photoFile ? URL.createObjectURL(draft.photoFile) : null,
    [draft.photoFile],
  );
  useEffect(() => () => { if (selectedFileUrl) URL.revokeObjectURL(selectedFileUrl); }, [selectedFileUrl]);

  const clearPrivateForm = useCallback(() => {
    setDraft(emptyDraft());
    setOptions(null);
    setRefreshedWines(null);
    setServerMatchConflict(false);
    setUncertainOperation(null);
    setError(null);
    setSuccess(null);
    operationIdRef.current = newOperationId();
  }, []);

  const expireAccess = useCallback(() => {
    clearPrivateForm();
    resetPrivateCart();
    void queryClient.invalidateQueries({ queryKey: ["cart-context"] });
    void queryClient.invalidateQueries({ queryKey: ["wine-catalog"] });
    dialogRef.current?.close();
    onCloseRef.current();
  }, [clearPrivateForm, queryClient]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open) {
      if (!dialog.open) {
        clearPrivateForm();
        dialog.showModal();
      }
      let active = true;
      setOptionsLoading(true);
      void getInventoryOptions().then((result) => {
        if (active) setOptions(result);
      }).catch((loadError: unknown) => {
        if (!active) return;
        if (isAccessDenied(loadError)) expireAccess();
        else setError(errorMessage(loadError, "Inventory options are unavailable"));
      }).finally(() => {
        if (active) setOptionsLoading(false);
      });
      return () => { active = false; };
    }
    if (dialog.open) dialog.close();
    clearPrivateForm();
  }, [open, clearPrivateForm, expireAccess]);

  const updateDraft = (update: (current: DialogDraft) => DialogDraft, preserveMatchConflict = false) => {
    if (saving || uncertainOperation) return;
    operationIdRef.current = newOperationId();
    setDraft(update);
    setError(null);
    setSuccess(null);
    if (!preserveMatchConflict) setServerMatchConflict(false);
  };

  const handleClose = () => {
    if (saving || uncertainOperation) return;
    clearPrivateForm();
    dialogRef.current?.close();
    onCloseRef.current();
  };

  const handleNativeCancel = (event: React.SyntheticEvent<HTMLDialogElement>) => {
    event.preventDefault();
    handleClose();
  };

  const invalidateAfterSave = () => {
    void Promise.allSettled([
      queryClient.invalidateQueries({ queryKey: ["cart-context"] }),
      queryClient.invalidateQueries({ queryKey: ["wine-catalog"] }),
      queryClient.invalidateQueries({ queryKey: ["cellar-summary"] }),
      queryClient.invalidateQueries({ queryKey: ["inventory-options"] }),
      queryClient.invalidateQueries({ queryKey: ["host-inventory"] }),
    ]);
    clearPrivateForm();
    dialogRef.current?.close();
    onCloseRef.current();
    onSavedRef.current();
  };

  const sendFrozenOperation = async (operation: FrozenOperation) => {
    if (operation.kind === "add") await postAddWine(operation.payload);
    else await postRestockWine(operation.payload);
    setUncertainOperation(null);
    setError(null);
    setSuccess("Stock saved.");
    invalidateAfterSave();
  };

  const submitDraft = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (saving || uncertainOperation) return;
    setError(null);
    setSuccess(null);
    setSaving(true);
    let frozen: FrozenOperation | null = null;
    try {
      const contributorName = draft.contributorName.trim();
      const fridge = draft.fridge.trim();
      const shelf = draft.shelf.trim();
      const amount = normalizeQuantity(Number(draft.quantityText));
      if (!contributorName || !fridge || !shelf) throw new Error("Enter contributor, fridge, and shelf.");
      if (!/^[1-9]\d*$/.test(draft.quantityText)) throw new Error("Quantity must be a positive whole number.");

      if (draft.mode === "new") {
        if (matchingWines.length > 0 && !draft.createSeparate) {
          throw new Error("Choose Add bottles to a matching wine or confirm a separate label.");
        }
        let photoId = draft.uploadedPhotoId;
        if (draft.photoFile && !photoId) {
          const receipt = await postUploadWinePhoto(draft.photoFile);
          photoId = receipt.id;
          setDraft((current) => ({ ...current, uploadedPhotoId: receipt.id }));
        }
        const wine = normalizeWineInput({ ...draft.wine, photoId: photoId ?? null });
        frozen = {
          kind: "add",
          payload: {
            operationId: operationIdRef.current,
            contributorName,
            wine,
            fridge,
            shelf,
            quantity: amount,
            createSeparate: draft.createSeparate,
          },
        };
      } else {
        if (draft.photoFile || draft.uploadedPhotoId) {
          throw new Error("Remove selected photo before restocking an existing wine.");
        }
        if (!draft.selectedWineId) throw new Error("Choose a wine to restock.");
        frozen = {
          kind: "restock",
          payload: {
            operationId: operationIdRef.current,
            contributorName,
            wineId: draft.selectedWineId,
            fridge,
            shelf,
            quantity: amount,
          },
        };
      }
      await sendFrozenOperation(frozen);
    } catch (saveError: unknown) {
      const failure = saveError as EntryRequestError;
      if (isAccessDenied(saveError)) {
        expireAccess();
      } else if (failure?.code === "MATCHING_WINE") {
        setServerMatchConflict(true);
        setError(errorMessage(saveError, "A matching wine already exists. Choose it or confirm a separate label."));
        try {
          const refreshed = await refreshEntryCatalog();
          if (refreshed === null) expireAccess();
          else setRefreshedWines(refreshed);
        } catch (catalogError: unknown) {
          if (isAccessDenied(catalogError)) expireAccess();
        }
      } else if (frozen && (failure?.uncertain ?? true)) {
        setUncertainOperation(frozen);
        setError("Connection outcome is unclear. Retry this exact request to confirm stock status.");
      } else {
        setError(errorMessage(saveError, "Stock could not be saved."));
      }
    } finally {
      setSaving(false);
    }
  };

  const retryUncertainOperation = async () => {
    if (!uncertainOperation || saving) return;
    setSaving(true);
    setError(null);
    try {
      await sendFrozenOperation(uncertainOperation);
    } catch (retryError: unknown) {
      if (isAccessDenied(retryError)) expireAccess();
      else if ((retryError as EntryRequestError)?.uncertain ?? true) {
        setError("Connection outcome is still unclear. Retry same request again.");
      } else {
        setUncertainOperation(null);
        setError(errorMessage(retryError, "Request was rejected. Review fields before retrying."));
      }
    } finally {
      setSaving(false);
    }
  };

  const selectMatchingWine = (wineId: string) => {
    updateDraft((current) => ({ ...current, mode: "restock", selectedWineId: wineId, createSeparate: false }));
  };

  const selectPhoto = (file: File | undefined) => {
    if (!file) return;
    if (!ALLOWED_PHOTO_TYPES.has(file.type)) {
      setError("Choose JPEG, PNG, or WebP photo.");
      return;
    }
    if (file.size > MAX_PHOTO_BYTES) {
      setError("Photo must be 5 MB or smaller.");
      return;
    }
    updateDraft((current) => ({ ...current, photoFile: file, uploadedPhotoId: null }));
  };

  const clearPhoto = () => updateDraft((current) => ({ ...current, photoFile: null, uploadedPhotoId: null }));

  const quantityInvalid = !/^[1-9]\d*$/.test(draft.quantityText) || Number(draft.quantityText) > 2147483647;
  const newWineInvalid = draft.mode === "new" && (
    !draft.wine.producer.trim() || !draft.wine.wineName.trim() ||
    !Number.isInteger(draft.wine.bottleSizeMl) || draft.wine.bottleSizeMl <= 0
  );
  const hasPhotoForRestock = draft.mode === "restock" && (!!draft.photoFile || !!draft.uploadedPhotoId);
  const canSubmit = !!options && !optionsLoading && !saving && !uncertainOperation && !hasPhotoForRestock &&
    !!draft.contributorName.trim() && !!draft.fridge.trim() && !!draft.shelf.trim() &&
    !quantityInvalid && !newWineInvalid && (draft.mode === "new" || !!draft.selectedWineId) &&
    (matchingWines.length === 0 || draft.createSeparate || draft.mode === "restock");

  return (
    <dialog ref={dialogRef} className={styles.dialog} aria-labelledby="add-wine-title" onCancel={handleNativeCancel}>
      <form className={styles.form} onSubmit={submitDraft}>
        <header className={styles.header}>
          <div>
            <p className={styles.eyebrow}>CELLAR INVENTORY</p>
            <h2 id="add-wine-title">Add wine or bottles</h2>
          </div>
          <button className={styles.close} type="button" onClick={handleClose} disabled={saving || !!uncertainOperation} aria-label="Close dialog">×</button>
        </header>

        <div className={styles.modeTabs} role="group" aria-label="Stock action">
          <button type="button" aria-pressed={draft.mode === "new"} onClick={() => updateDraft((current) => ({ ...current, mode: "new", selectedWineId: "" }))} disabled={saving || !!uncertainOperation}>New wine</button>
          <button type="button" aria-pressed={draft.mode === "restock"} onClick={() => updateDraft((current) => ({ ...current, mode: "restock", createSeparate: false }))} disabled={saving || !!uncertainOperation}>Restock existing</button>
        </div>

        <div className={styles.body}>
          {draft.mode === "new" ? (
            <section className={styles.section} aria-label="Wine details">
              <WineFields
                value={draft.wine}
                categories={options?.categories ?? ({} as InventoryOptions["categories"])}
                disabled={saving || !!uncertainOperation}
                onChange={(wine) => updateDraft((current) => ({ ...current, wine, createSeparate: false }))}
              />

              <div className={styles.photoBlock}>
                <label className={styles.field}>
                  <span>Photo <small>Optional · JPEG, PNG, WebP · up to 5 MB</small></span>
                  <input
                    type="file"
                    accept="image/jpeg,image/png,image/webp"
                    onChange={(event) => {
                      const file = event.currentTarget.files?.[0];
                      event.currentTarget.value = "";
                      selectPhoto(file);
                    }}
                    disabled={saving || !!uncertainOperation}
                  />
                </label>
                {draft.photoFile && (
                  <div className={styles.photoPreview}>
                    {selectedFileUrl && <img src={selectedFileUrl} alt="Selected wine photo preview" />}
                    <div><strong>{draft.photoFile.name}</strong><span>{draft.uploadedPhotoId ? "Photo uploaded; will attach on save." : "Selected photo must upload before stock can save."}</span></div>
                    <button type="button" className={styles.secondaryButton} onClick={clearPhoto} disabled={saving || !!uncertainOperation}>Remove photo</button>
                  </div>
                )}
              </div>
            </section>
          ) : (
            <section className={styles.section} aria-label="Choose existing wine">
              <label className={styles.field}>
                <span>Wine <b aria-hidden="true">*</b></span>
                <select value={draft.selectedWineId} required onChange={(event) => {
                  const selectedWineId = event.currentTarget.value;
                  updateDraft((current) => ({ ...current, selectedWineId }));
                }} disabled={saving || !!uncertainOperation}>
                  <option value="">Choose wine</option>
                  {availableWines.map((wine) => <option key={wine.id} value={wine.id}>{wineTitle(wine)} · {wine.totalQuantity} bottles</option>)}
                </select>
              </label>
              {availableWines.length === 0 && <p className={styles.hint}>No existing wines available. Add a new wine first.</p>}
              {(draft.photoFile || draft.uploadedPhotoId) && (
                <div className={styles.notice} role="status">
                  <p>Selected photo belongs to new wine details. Remove it before restocking an existing wine.</p>
                  <button type="button" className={styles.secondaryButton} onClick={clearPhoto} disabled={saving || !!uncertainOperation}>Remove selected photo</button>
                </div>
              )}
            </section>
          )}

          {draft.mode === "new" && (matchingWines.length > 0 || serverMatchConflict) && (
            <section className={styles.matchPanel} aria-label="Matching wines">
              <h3>Matching wine exists</h3>
              <p>Choose exact existing wine to add bottles, or confirm this entry as a separate label.</p>
              <div className={styles.matchList}>
                {matchingWines.map((wine) => (
                  <button key={wine.id} type="button" className={styles.matchButton} onClick={() => selectMatchingWine(wine.id)} disabled={saving || !!uncertainOperation || !!draft.photoFile || !!draft.uploadedPhotoId}>
                    <span>{wineTitle(wine)}</span><small>{wine.totalQuantity} bottles · Add bottles</small>
                  </button>
                ))}
              </div>
              {(draft.photoFile || draft.uploadedPhotoId) && <p className={styles.hint}>Remove selected photo before adding bottles to an existing wine.</p>}
              <label className={styles.confirmSeparate}>
                <input type="checkbox" checked={draft.createSeparate} onChange={(event) => {
                  const checked = event.currentTarget.checked;
                  updateDraft((current) => ({ ...current, createSeparate: checked }), true);
                }} disabled={saving || !!uncertainOperation} />
                <span>I confirm this is a separate label. Create a new wine record.</span>
              </label>
            </section>
          )}

          <section className={styles.stockFields} aria-label="Stock details">
            <label className={styles.field}>
              <span>Added by <b aria-hidden="true">*</b></span>
              <input value={draft.contributorName} required maxLength={80} autoComplete="name" onChange={(event) => {
                const contributorName = event.currentTarget.value;
                updateDraft((current) => ({ ...current, contributorName }));
              }} disabled={saving || !!uncertainOperation} />
            </label>
            <label className={styles.field}>
              <span>Fridge <b aria-hidden="true">*</b></span>
              <input value={draft.fridge} required maxLength={80} list="entry-fridges" autoComplete="off" onChange={(event) => {
                const fridge = event.currentTarget.value;
                updateDraft((current) => ({ ...current, fridge }));
              }} disabled={saving || !!uncertainOperation} />
              <datalist id="entry-fridges">{options?.locations.map((location) => <option key={location.id} value={location.fridge} />)}</datalist>
            </label>
            <label className={styles.field}>
              <span>Shelf <b aria-hidden="true">*</b></span>
              <input value={draft.shelf} required maxLength={80} list="entry-shelves" autoComplete="off" onChange={(event) => {
                const shelf = event.currentTarget.value;
                updateDraft((current) => ({ ...current, shelf }));
              }} disabled={saving || !!uncertainOperation} />
              <datalist id="entry-shelves">{options?.locations.filter((location) => !draft.fridge || location.fridge.toLocaleLowerCase() === draft.fridge.trim().toLocaleLowerCase()).map((location) => <option key={location.id} value={location.shelf} />)}</datalist>
            </label>
            <label className={styles.field}>
              <span>Quantity <b aria-hidden="true">*</b></span>
              <input type="number" inputMode="numeric" min={1} max={2147483647} step={1} value={draft.quantityText} required onChange={(event) => {
                const quantityText = event.currentTarget.value;
                updateDraft((current) => ({ ...current, quantityText }));
              }} disabled={saving || !!uncertainOperation} />
            </label>
          </section>
        </div>

        <footer className={styles.footer}>
          <div className={styles.feedback} aria-live="polite">
            {optionsLoading && <span>Loading cellar options…</span>}
            {!optionsLoading && !options && <span>Cellar options unavailable. Close and reopen to retry.</span>}
            {error && <span className={styles.error} role="alert">{error}</span>}
            {success && <span className={styles.success}>{success}</span>}
            {uncertainOperation && <button className={styles.retryButton} type="button" onClick={retryUncertainOperation} disabled={saving}>Retry exact request</button>}
          </div>
          <div className={styles.actions}>
            <button className={styles.secondaryButton} type="button" onClick={handleClose} disabled={saving || !!uncertainOperation}>Cancel</button>
            <button className={styles.primaryButton} type="submit" disabled={!canSubmit}>
              {saving ? "Saving…" : draft.mode === "new" ? "Add wine and stock" : "Add bottles"}
            </button>
          </div>
        </footer>
      </form>
    </dialog>
  );
};

export default AddWineDialog;
