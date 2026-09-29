import { useEffect, useMemo, useState, type FormEvent, type MouseEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { ArrowLeft, ArrowLeftRight, Check, LockKeyhole, MoveRight, Pencil, Plus, RefreshCw, ShieldCheck, Wine } from "lucide-react";
import { Button } from "../components/Button";
import { WineFields } from "../components/WineFields";
import { useAuth } from "../helpers/useAuth";
import { resetPrivateCart } from "../helpers/cartStore";
import type { WineInput } from "../helpers/inventoryPolicy";
import { categoryFields, type CategoryKey } from "../helpers/wineCatalog";
import {
  createHostOperationId, getHostContacts, getHostInventory, getInventoryOptions,
  hostErrorCode, hostErrorMessage, hostErrorStatus, invalidateHostInventoryQueries,
  postCorrectStock, postMoveStock, postSaveContact, postUpdateWine, wineInputFromCatalog,
  type HostContact, type HostInventoryWine, type HostStockRow,
} from "../helpers/hostInventoryService";
import CellarMenu from "../components/CellarMenu";
import styles from "./host-dashboard.module.css";

type Pane = "inventory" | "contacts";
type Notice = { tone: "error" | "success" | "info"; text: string };
type Action = "details" | "correct" | "move";
type BaseDraft = { wineId: string; expectedVersion: string; operationId: string; conflict?: boolean };
type DetailsDraft = BaseDraft & { kind: "details"; wine: WineInput };
type CorrectDraft = BaseDraft & { kind: "correct"; locationId: string; quantity: string; note: string };
type MoveDraft = BaseDraft & { kind: "move"; fromLocationId: string; fridge: string; shelf: string; quantity: string; note: string };
type WineDraft = DetailsDraft | CorrectDraft | MoveDraft;
type ContactDraft = {
  id?: string; expectedVersion?: string; operationId: string; displayName: string;
  phoneE164: string; isHost: boolean; active: boolean; conflict?: boolean;
};
type UncertainOperation =
  | { kind: "details"; draft: DetailsDraft }
  | { kind: "correct"; draft: CorrectDraft }
  | { kind: "move"; draft: MoveDraft }
  | { kind: "contact"; draft: ContactDraft };

const noCategories = (): Record<CategoryKey, string[]> => ({
  producer: [], wineName: [], vintage: [], country: [], region: [], subregion: [],
  appellation: [], grapeBlend: [], colour: [], wineStyle: [], sweetness: [], bottleSizeMl: [],
});

function rowFor(wine: HostInventoryWine | undefined, id: string): HostStockRow | undefined {
  return wine?.stockRows.find((row) => row.locationId === id);
}

function Count({ value }: { value: number }) {
  return <>{value} {value === 1 ? "bottle" : "bottles"}</>;
}

function InputError({ error }: { error: unknown }) {
  const status = hostErrorStatus(error);
  if (status !== 401 && status !== 403) return null;
  return <span className={styles.srOnly}>Host-only request was denied.</span>;
}

export default function HostDashboardPage() {
  const { authState } = useAuth();
  const queryClient = useQueryClient();
  const [authRejected, setAuthRejected] = useState(false);
  const enabled = authState.type === "authenticated" && !authRejected;
  const inventoryQuery = useQuery({ queryKey: ["host-inventory"], queryFn: () => getHostInventory(), enabled, retry: false, staleTime: 0 });
  const contactsQuery = useQuery({ queryKey: ["host-contacts"], queryFn: () => getHostContacts(), enabled, retry: false, staleTime: 0 });
  const optionsQuery = useQuery({ queryKey: ["inventory-options"], queryFn: () => getInventoryOptions(), enabled, retry: false, staleTime: 30_000 });
  const wines = inventoryQuery.data?.wines ?? [];
  const contacts = contactsQuery.data?.contacts ?? [];
  const options = optionsQuery.data;
  const hostContact = contacts.find((contact) => contact.isHost && contact.active);

  const [pane, setPane] = useState<Pane>("inventory");
  const [action, setAction] = useState<Action>("details");
  const [wineSearch, setWineSearch] = useState("");
  const [selectedId, setSelectedId] = useState("");
  const [wineDraft, setWineDraft] = useState<WineDraft | null>(null);
  const [contactDraft, setContactDraft] = useState<ContactDraft | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [pending, setPending] = useState(false);
  const [uncertain, setUncertain] = useState<UncertainOperation | null>(null);
  const wine = wines.find((item) => item.id === selectedId);
  const filteredWines = useMemo(() => {
    const normalize = (value: string) => value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
    const needle = normalize(wineSearch.trim());
    return needle ? wines.filter((item) => normalize(item.producer + " " + item.wineName).includes(needle)) : wines;
  }, [wineSearch, wines]);

  const errors = [inventoryQuery.error, contactsQuery.error, optionsQuery.error];
  const denied = authRejected || authState.type === "unauthenticated" || errors.some((error) => hostErrorStatus(error) === 401 || hostErrorStatus(error) === 403);
  const error = errors.find(Boolean);
  const loading = authState.type === "loading" || (enabled && (
    inventoryQuery.isPending || contactsQuery.isPending || optionsQuery.isPending ||
    inventoryQuery.isFetching || contactsQuery.isFetching || optionsQuery.isFetching
  ));
  const ready = enabled && inventoryQuery.isSuccess && contactsQuery.isSuccess && optionsQuery.isSuccess &&
    !inventoryQuery.isFetching && !contactsQuery.isFetching && !optionsQuery.isFetching && !denied;
  const locked = pending || uncertain !== null;

  useEffect(() => {
    if (!denied || authRejected) return;
    resetPrivateCart();
    setAuthRejected(true);
    setWineDraft(null);
    setContactDraft(null);
    setUncertain(null);
    setNotice(null);
    for (const key of ["host-inventory", "host-contacts", "inventory-options", "cart-context", "host-checkouts", "checkout-receipt"]) {
      queryClient.removeQueries({ queryKey: [key] });
    }
  }, [authRejected, denied, queryClient]);

  function newWineDraft(item: HostInventoryWine, next: Action): WineDraft | null {
    const operationId = createHostOperationId();
    if (next === "details") return { kind: "details", wineId: item.id, expectedVersion: item.version, operationId, wine: wineInputFromCatalog(item) };
    const row = next === "correct" ? item.stockRows[0] : item.stockRows.find((stock) => stock.quantity > 0) ?? item.stockRows[0];
    if (!row) return null;
    return next === "correct"
      ? { kind: "correct", wineId: item.id, locationId: row.locationId, expectedVersion: row.version, operationId, quantity: String(row.quantity), note: "" }
      : { kind: "move", wineId: item.id, fromLocationId: row.locationId, expectedVersion: row.version, operationId, fridge: "", shelf: "", quantity: "1", note: "" };
  }

  function selectAction(item: HostInventoryWine, next: Action) {
    if (pending || uncertain) return;
    setSelectedId(item.id);
    setAction(next);
    setWineDraft(newWineDraft(item, next));
    setNotice(next !== "details" && item.stockRows.length === 0
      ? { tone: "info", text: "This wine has no stock row yet. Add or restock bottles before correcting or moving stock." }
      : null);
  }

  function changeWine(update: (draft: WineDraft) => WineDraft) {
    if (!wineDraft || pending || uncertain) return;
    setWineDraft({ ...update(wineDraft), operationId: createHostOperationId() });
    setNotice(null);
  }

  function changeContact(update: (draft: ContactDraft) => ContactDraft) {
    if (!contactDraft || pending || uncertain) return;
    setContactDraft({ ...update(contactDraft), operationId: createHostOperationId() });
    setNotice(null);
  }

  function clearPrivateState() {
    resetPrivateCart();
    setAuthRejected(true);
    setWineDraft(null);
    setContactDraft(null);
    setUncertain(null);
    setNotice(null);
    for (const key of ["host-inventory", "host-contacts", "inventory-options", "cart-context", "host-checkouts", "checkout-receipt"]) {
      queryClient.removeQueries({ queryKey: [key] });
    }
  }

  function isUncertainFailure(cause: unknown): boolean {
    const status = hostErrorStatus(cause);
    return status === undefined || status === 408 || status >= 500;
  }

  async function refreshAll() {
    await invalidateHostInventoryQueries(queryClient);
  }

  async function submitDetails(event: FormEvent) {
    event.preventDefault();
    if (pending || uncertain || !wineDraft || wineDraft.kind !== "details" || wineDraft.conflict) return;
    const draft = wineDraft;
    setPending(true); setNotice(null);
    try {
      await postUpdateWine({ operationId: draft.operationId, wineId: draft.wineId, expectedVersion: draft.expectedVersion, wine: draft.wine });
      await refreshAll();
      setWineDraft(null);
      setNotice({ tone: "success", text: "Wine details saved." });
    } catch (cause) {
      if (hostErrorStatus(cause) === 401 || hostErrorStatus(cause) === 403) {
        clearPrivateState();
        return;
      }
      if (hostErrorCode(cause) === "VERSION_CONFLICT") {
        setWineDraft({ ...draft, conflict: true });
        await queryClient.invalidateQueries({ queryKey: ["host-inventory"] });
      } else if (isUncertainFailure(cause)) {
        setUncertain({ kind: "details", draft });
      }
      setNotice({ tone: "error", text: isUncertainFailure(cause)
        ? "Save outcome is unknown. Retry the exact request below before changing this form."
        : hostErrorMessage(cause, "Wine details could not be saved. Your edits remain here.") });
    } finally { setPending(false); }
  }

  async function submitCorrection(event: FormEvent) {
    event.preventDefault();
    if (pending || uncertain || !wineDraft || wineDraft.kind !== "correct" || wineDraft.conflict) return;
    const draft = wineDraft;
    setPending(true); setNotice(null);
    try {
      await postCorrectStock({ operationId: draft.operationId, wineId: draft.wineId, locationId: draft.locationId, expectedVersion: draft.expectedVersion, quantity: Number(draft.quantity), note: draft.note });
      await refreshAll();
      setWineDraft(null);
      setNotice({ tone: "success", text: "Stock count saved." });
    } catch (cause) {
      if (hostErrorStatus(cause) === 401 || hostErrorStatus(cause) === 403) {
        clearPrivateState();
        return;
      }
      if (hostErrorCode(cause) === "VERSION_CONFLICT") {
        setWineDraft({ ...draft, conflict: true });
        await queryClient.invalidateQueries({ queryKey: ["host-inventory"] });
      } else if (isUncertainFailure(cause)) {
        setUncertain({ kind: "correct", draft });
      }
      setNotice({ tone: "error", text: isUncertainFailure(cause)
        ? "Save outcome is unknown. Retry the exact request below before changing this form."
        : hostErrorMessage(cause, "Stock count could not be saved. Your edits remain here.") });
    } finally { setPending(false); }
  }

  async function submitMove(event: FormEvent) {
    event.preventDefault();
    if (pending || uncertain || !wineDraft || wineDraft.kind !== "move" || wineDraft.conflict) return;
    const draft = wineDraft;
    setPending(true); setNotice(null);
    try {
      await postMoveStock({ operationId: draft.operationId, wineId: draft.wineId, fromLocationId: draft.fromLocationId, expectedVersion: draft.expectedVersion, fridge: draft.fridge, shelf: draft.shelf, quantity: Number(draft.quantity), note: draft.note });
      await refreshAll();
      setWineDraft(null);
      setNotice({ tone: "success", text: "Bottles moved. Total stock is unchanged." });
    } catch (cause) {
      if (hostErrorStatus(cause) === 401 || hostErrorStatus(cause) === 403) {
        clearPrivateState();
        return;
      }
      if (hostErrorCode(cause) === "VERSION_CONFLICT") {
        setWineDraft({ ...draft, conflict: true });
        await queryClient.invalidateQueries({ queryKey: ["host-inventory"] });
      } else if (isUncertainFailure(cause)) {
        setUncertain({ kind: "move", draft });
      }
      setNotice({ tone: "error", text: isUncertainFailure(cause)
        ? "Move outcome is unknown. Retry the exact request below before changing this form."
        : hostErrorMessage(cause, "Bottles could not be moved. Your edits remain here.") });
    } finally { setPending(false); }
  }

  function startNewContact() {
    if (pending || uncertain) return;
    setContactDraft({ operationId: createHostOperationId(), displayName: "", phoneE164: "", isHost: !hostContact, active: true });
    setNotice(null);
  }

  function editContact(item: HostContact) {
    if (pending || uncertain) return;
    setContactDraft({ id: item.id, expectedVersion: item.version, operationId: createHostOperationId(), displayName: item.displayName, phoneE164: item.phoneE164, isHost: item.isHost, active: item.active });
    setNotice(null);
  }

  async function submitContact(event: FormEvent) {
    event.preventDefault();
    if (pending || uncertain || !contactDraft || contactDraft.conflict) return;
    const draft = contactDraft;
    setPending(true); setNotice(null);
    try {
      await postSaveContact({
        operationId: draft.operationId,
        ...(draft.id ? { id: draft.id, expectedVersion: draft.expectedVersion } : {}),
        displayName: draft.displayName, phoneE164: draft.phoneE164, isHost: draft.isHost, active: draft.active,
      });
      await refreshAll();
      setContactDraft(null);
      setNotice({ tone: "success", text: "Contact saved." });
    } catch (cause) {
      if (hostErrorStatus(cause) === 401 || hostErrorStatus(cause) === 403) {
        clearPrivateState();
        return;
      }
      if (hostErrorCode(cause) === "VERSION_CONFLICT") {
        setContactDraft({ ...draft, conflict: true });
        await queryClient.invalidateQueries({ queryKey: ["host-contacts"] });
      } else if (isUncertainFailure(cause)) {
        setUncertain({ kind: "contact", draft });
      }
      setNotice({ tone: "error", text: isUncertainFailure(cause)
        ? "Save outcome is unknown. Retry the exact request below before changing this form."
        : hostErrorMessage(cause, "Contact could not be saved. Your edits remain here.") });
    } finally { setPending(false); }
  }

  function adoptWineVersion() {
    if (pending || uncertain || !wineDraft || !wine) return;
    const latest = wineDraft.kind === "details" ? wine.version : rowFor(wine, wineDraft.kind === "correct" ? wineDraft.locationId : wineDraft.fromLocationId)?.version;
    if (!latest) return;
    setWineDraft({ ...wineDraft, expectedVersion: latest, operationId: createHostOperationId(), conflict: false });
    setNotice({ tone: "info", text: "Latest version selected. Review your inputs before saving again." });
  }

  function adoptContactVersion() {
    if (pending || uncertain || !contactDraft?.id) return;
    const latest = contacts.find((item) => item.id === contactDraft.id);
    if (!latest) return;
    setContactDraft({ ...contactDraft, expectedVersion: latest.version, operationId: createHostOperationId(), conflict: false });
    setNotice({ tone: "info", text: "Latest version selected. Review your inputs before saving again." });
  }

  async function retryUncertain() {
    if (pending || !uncertain) return;
    const operation = uncertain;
    setPending(true);
    setNotice(null);
    try {
      if (operation.kind === "details") {
        const draft = operation.draft;
        await postUpdateWine({ operationId: draft.operationId, wineId: draft.wineId, expectedVersion: draft.expectedVersion, wine: draft.wine });
        setWineDraft(null);
        setNotice({ tone: "success", text: "Wine details saved." });
      } else if (operation.kind === "correct") {
        const draft = operation.draft;
        await postCorrectStock({ operationId: draft.operationId, wineId: draft.wineId, locationId: draft.locationId, expectedVersion: draft.expectedVersion, quantity: Number(draft.quantity), note: draft.note });
        setWineDraft(null);
        setNotice({ tone: "success", text: "Stock count saved." });
      } else if (operation.kind === "move") {
        const draft = operation.draft;
        await postMoveStock({ operationId: draft.operationId, wineId: draft.wineId, fromLocationId: draft.fromLocationId, expectedVersion: draft.expectedVersion, fridge: draft.fridge, shelf: draft.shelf, quantity: Number(draft.quantity), note: draft.note });
        setWineDraft(null);
        setNotice({ tone: "success", text: "Bottles moved. Total stock is unchanged." });
      } else {
        const draft = operation.draft;
        await postSaveContact({ operationId: draft.operationId, ...(draft.id ? { id: draft.id, expectedVersion: draft.expectedVersion } : {}), displayName: draft.displayName, phoneE164: draft.phoneE164, isHost: draft.isHost, active: draft.active });
        setContactDraft(null);
        setNotice({ tone: "success", text: "Contact saved." });
      }
      setUncertain(null);
      await refreshAll();
    } catch (cause) {
      if (hostErrorStatus(cause) === 401 || hostErrorStatus(cause) === 403) {
        clearPrivateState();
        return;
      }
      setUncertain(isUncertainFailure(cause) ? operation : null);
      if (hostErrorCode(cause) === "VERSION_CONFLICT") {
        if (operation.kind === "contact") {
          setContactDraft({ ...operation.draft, conflict: true });
          await queryClient.invalidateQueries({ queryKey: ["host-contacts"] });
        } else {
          setWineDraft({ ...operation.draft, conflict: true });
          await queryClient.invalidateQueries({ queryKey: ["host-inventory"] });
        }
      }
      setNotice({ tone: "error", text: isUncertainFailure(cause)
        ? "Outcome is still unknown. Retry this exact request again."
        : hostErrorMessage(cause, "Request was rejected. Review the form before trying again.") });
    } finally { setPending(false); }
  }

  function guardNavigation(event: MouseEvent<HTMLAnchorElement>) {
    if (!locked) return;
    event.preventDefault();
    setNotice({ tone: "info", text: "Confirm the exact request before leaving this dashboard." });
  }

  return (
    <div className={styles.frame}>
      <CellarMenu onNavigate={guardNavigation} navigationDisabled={locked}>
          <Link to="/" aria-disabled={locked} onClick={guardNavigation}>Overview</Link><Link to="/wines" aria-disabled={locked} onClick={guardNavigation}>Wine inventory</Link><span aria-current="page">Host dashboard</span><Link to="/host-checkouts" aria-disabled={locked} onClick={guardNavigation}>Checkouts</Link><Link to="/host-access" aria-disabled={locked} onClick={guardNavigation}>Host access</Link>
        
      </CellarMenu>
      <main className={styles.main}>
        <header className={styles.topbar}><span>YOUR CELLAR　/　HOST TOOLS</span><span className={styles.privacy}><ShieldCheck size={14} aria-hidden="true" /> HOST ACCESS</span></header>
        <div className={styles.content}>
          <Link to="/wines" className={styles.backLink} aria-disabled={locked} onClick={guardNavigation}><ArrowLeft size={14} aria-hidden="true" /> Wine inventory</Link>
          <p className={styles.eyebrow}>CELLAR ADMINISTRATION</p><h1>Host dashboard</h1>
          <p className={styles.intro}>Update wine details, correct counts, move bottles, and manage cellar contacts.</p>

          {loading ? (
            <section className={styles.state} role="status"><Wine size={24} aria-hidden="true" /><h2>Opening host tools</h2><p>Checking host access and loading private cellar data…</p><div className={styles.loadingBar} /></section>
          ) : denied ? (
            <section className={styles.state} role="alert"><span className={styles.lockBadge}><LockKeyhole size={20} aria-hidden="true" /></span><p className={styles.eyebrow}>HOST ACCESS REQUIRED</p><h2>This dashboard is private.</h2><p>Sign in with the cellar host account to manage contacts and stock.</p><Button asChild className={styles.signIn}><Link to="/login">Host sign in <span aria-hidden="true">→</span></Link></Button></section>
          ) : error ? (
            <section className={styles.state} role="alert"><Wine size={24} aria-hidden="true" /><InputError error={error} /><h2>Host data unavailable</h2><p>Private contacts and stock stay hidden until data can be checked.</p><Button variant="outline" onClick={() => { void inventoryQuery.refetch(); void contactsQuery.refetch(); void optionsQuery.refetch(); }}>Try again</Button></section>
          ) : ready ? (
            <>
              {!hostContact && <div className={styles.setupBanner}><ShieldCheck size={18} aria-hidden="true" /><span><strong>Host contact not set.</strong> Save an active contact with “Designated host” selected.</span><button type="button" disabled={locked} onClick={() => { setPane("contacts"); startNewContact(); }}>Set up host contact</button></div>}
              <div className={styles.tabs} role="tablist" aria-label="Host dashboard sections">
                <button type="button" role="tab" aria-selected={pane === "inventory"} disabled={locked} onClick={() => { if (locked) return; setPane("inventory"); setNotice(null); }}>Wine inventory <span>{wines.length}</span></button>
                <button type="button" role="tab" aria-selected={pane === "contacts"} disabled={locked} onClick={() => { if (locked) return; setPane("contacts"); setNotice(null); }}>Contacts <span>{contacts.length}</span></button>
              </div>
              {notice && <div className={styles.notice + " " + styles[notice.tone]} role={notice.tone === "error" ? "alert" : "status"}><span>{notice.text}</span><button type="button" aria-label="Dismiss notice" onClick={() => setNotice(null)}>×</button></div>}
              {uncertain && <div className={styles.uncertainRetry}><span>Form locked until request outcome is confirmed.</span><Button type="button" variant="outline" disabled={pending} onClick={() => void retryUncertain()}>Retry exact request</Button></div>}

              {pane === "inventory" ? (
                <section className={styles.section} role="tabpanel" aria-label="Wine inventory">
                  <div className={styles.sectionHead}><div><p className={styles.eyebrow}>STOCK CONTROL</p><h2>Wine inventory</h2><p>Choose a label to edit details or stock rows.</p></div><span className={styles.summaryPill}>{wines.length} labels · {wines.reduce((total, item) => total + item.totalQuantity, 0)} bottles</span></div>
                  <div className={styles.inventoryLayout}>
                    <div className={styles.wineListPanel}>
                      <label className={styles.field}><span>Find a wine</span><input type="search" value={wineSearch} disabled={locked} onChange={(event) => setWineSearch(event.currentTarget.value)} placeholder="Producer or wine name" /></label>
                      <div className={styles.wineList} aria-label="Wines">
                        {filteredWines.length === 0 ? <p className={styles.emptyList}>No wines match this search.</p> : filteredWines.map((item) => <button type="button" key={item.id} disabled={locked} className={styles.wineChoice + (selectedId === item.id ? " " + styles.selectedChoice : "")} onClick={() => selectAction(item, action)}><span><strong>{item.wineName}</strong><small>{item.producer}{item.vintage ? " · " + item.vintage : ""}</small></span><span className={styles.choiceCount}><Count value={item.totalQuantity} /></span></button>)}
                      </div>
                    </div>
                    <div className={styles.editorPanel}>
                      {!wine || !wineDraft ? <div className={styles.selectPrompt}><span className={styles.iconBadge}><Wine size={20} aria-hidden="true" /></span><h3>Select a wine</h3><p>Choose a label to edit details, correct stock, or move bottles.</p></div> : <>
                        <div className={styles.selectedHeading}><div><p className={styles.eyebrow}>{wine.producer}</p><h3>{wine.wineName}</h3><p>{wine.vintage || "No vintage"} · {wine.totalQuantity} bottles across {wine.stockRows.length} stock rows</p></div><button type="button" className={styles.iconButton} aria-label="Refresh inventory" disabled={locked} onClick={() => void inventoryQuery.refetch()}><RefreshCw size={16} aria-hidden="true" /></button></div>
                        <div className={styles.actionTabs} role="tablist" aria-label="Wine actions">
                          <button type="button" role="tab" aria-selected={action === "details"} disabled={locked} onClick={() => selectAction(wine, "details")}><Pencil size={14} aria-hidden="true" /> Details</button>
                          <button type="button" role="tab" aria-selected={action === "correct"} disabled={locked} onClick={() => selectAction(wine, "correct")}><Check size={14} aria-hidden="true" /> Correct count</button>
                          <button type="button" role="tab" aria-selected={action === "move"} disabled={locked} onClick={() => selectAction(wine, "move")}><ArrowLeftRight size={14} aria-hidden="true" /> Move bottles</button>
                        </div>
                        {wineDraft.conflict && <div className={styles.conflictBox} role="alert"><strong>Inventory changed while you were editing.</strong><span>Your inputs are preserved. Review current values before saving again.</span>{wineDraft.kind === "details" && <details className={styles.latestReview}><summary>Current saved wine details · version {wine.version}</summary><dl>{categoryFields.map(({ key, label }) => <div key={key}><dt>{label}</dt><dd>{String(wine[key] ?? "—")}</dd></div>)}</dl></details>}<Button type="button" variant="outline" size="sm" disabled={pending || uncertain !== null} onClick={adoptWineVersion}>Use latest version</Button></div>}

                        {wineDraft.kind === "details" && <form className={styles.form} onSubmit={submitDetails}>
                          <WineFields value={wineDraft.wine} onChange={(value) => changeWine((draft) => draft.kind === "details" ? { ...draft, wine: value } : draft)} categories={options?.categories ?? noCategories()} disabled={locked} />
                          {wine.photoPath && <div className={styles.photoRow}><img src={wine.photoPath} alt="Current wine" /><span>{wineDraft.wine.photoId === null ? "Current photo will be removed when saved." : "Current wine photo"}</span><Button type="button" variant="outline" size="sm" disabled={locked} onClick={() => changeWine((draft) => draft.kind === "details" ? { ...draft, wine: { ...draft.wine, photoId: draft.wine.photoId === null ? undefined : null } } : draft)}>{wineDraft.wine.photoId === null ? "Keep photo" : "Remove photo"}</Button></div>}
                          <p className={styles.hint}>Photo replacement is unavailable until cellar storage is connected. Imported photos stay unless you remove them.</p>
                          <div className={styles.formActions}><Button type="submit" disabled={locked || wineDraft.conflict}>{pending ? "Saving…" : "Save wine details"}</Button></div>
                        </form>}

                        {wineDraft.kind === "correct" && <form className={styles.form} onSubmit={submitCorrection}>
                          <label className={styles.field}><span>Stock location</span><select required value={wineDraft.locationId} disabled={locked} onChange={(event) => { const id = event.currentTarget.value; const row = rowFor(wine, id); changeWine((draft) => draft.kind === "correct" ? { ...draft, locationId: id, expectedVersion: row?.version ?? "0", quantity: String(row?.quantity ?? 0) } : draft); }}>{wine.stockRows.map((row) => <option key={row.locationId} value={row.locationId}>{row.fridge} · {row.shelf} ({row.quantity} bottles)</option>)}</select></label>
                          <label className={styles.field}><span>Correct bottle count</span><input type="number" min={0} max={2147483647} step={1} required value={wineDraft.quantity} disabled={locked} onChange={(event) => { const value = event.currentTarget.value; changeWine((draft) => draft.kind === "correct" ? { ...draft, quantity: value } : draft); }} /></label>
                          <label className={styles.field}><span>Reason for correction</span><textarea minLength={1} maxLength={500} required rows={3} value={wineDraft.note} disabled={locked} onChange={(event) => { const value = event.currentTarget.value; changeWine((draft) => draft.kind === "correct" ? { ...draft, note: value } : draft); }} placeholder="For example: recount after dinner" /></label>
                          <p className={styles.hint}>Correction records the difference in the stock ledger. A zero change creates no ledger entry.</p>
                          <div className={styles.formActions}><Button type="submit" disabled={locked || wineDraft.conflict || wine.stockRows.length === 0}>{pending ? "Saving…" : "Save correction"}</Button></div>
                        </form>}

                        {wineDraft.kind === "move" && <form className={styles.form} onSubmit={submitMove}>
                          <label className={styles.field}><span>Move from</span><select required value={wineDraft.fromLocationId} disabled={locked} onChange={(event) => { const id = event.currentTarget.value; const row = rowFor(wine, id); changeWine((draft) => draft.kind === "move" ? { ...draft, fromLocationId: id, expectedVersion: row?.version ?? "0" } : draft); }}>{wine.stockRows.map((row) => <option key={row.locationId} value={row.locationId}>{row.fridge} · {row.shelf} ({row.quantity} bottles)</option>)}</select></label>
                          <label className={styles.field}><span>Move to fridge</span><input list="dashboard-fridges" maxLength={80} required value={wineDraft.fridge} disabled={locked} onChange={(event) => { const value = event.currentTarget.value; changeWine((draft) => draft.kind === "move" ? { ...draft, fridge: value } : draft); }} /></label>
                          <datalist id="dashboard-fridges">{[...new Set(options?.locations.map((item) => item.fridge) ?? [])].map((item) => <option key={item} value={item} />)}</datalist>
                          <label className={styles.field}><span>Move to shelf</span><input list="dashboard-shelves" maxLength={80} required value={wineDraft.shelf} disabled={locked} onChange={(event) => { const value = event.currentTarget.value; changeWine((draft) => draft.kind === "move" ? { ...draft, shelf: value } : draft); }} /></label>
                          <datalist id="dashboard-shelves">{[...new Set(options?.locations.map((item) => item.shelf) ?? [])].map((item) => <option key={item} value={item} />)}</datalist>
                          <label className={styles.field}><span>Bottles to move</span><input type="number" min={1} max={2147483647} step={1} required value={wineDraft.quantity} disabled={locked} onChange={(event) => { const value = event.currentTarget.value; changeWine((draft) => draft.kind === "move" ? { ...draft, quantity: value } : draft); }} /></label>
                          <label className={styles.field}><span>Reason for move</span><textarea minLength={1} maxLength={500} required rows={3} value={wineDraft.note} disabled={locked} onChange={(event) => { const value = event.currentTarget.value; changeWine((draft) => draft.kind === "move" ? { ...draft, note: value } : draft); }} placeholder="For example: moved to serving fridge" /></label>
                          <p className={styles.hint}>Move subtracts and adds the same number of bottles in one transaction.</p>
                          <div className={styles.formActions}><Button type="submit" disabled={locked || wineDraft.conflict || wine.stockRows.length === 0}><MoveRight size={16} aria-hidden="true" /> {pending ? "Moving…" : "Move bottles"}</Button></div>
                        </form>}
                      </>}
                    </div>
                  </div>
                </section>
              ) : (
                <section className={styles.section} role="tabpanel" aria-label="Contacts">
                  <div className={styles.sectionHead}><div><p className={styles.eyebrow}>CELLAR CONTACTS</p><h2>Contacts</h2><p>Manage active contact details and host designation.</p></div><Button type="button" disabled={locked} onClick={startNewContact}><Plus size={15} aria-hidden="true" /> Add contact</Button></div>
                  {!hostContact && <div className={styles.setupBanner}><ShieldCheck size={18} aria-hidden="true" /><span>No active host contact. Save one active contact with “Designated host” selected.</span></div>}
                  <div className={styles.contactLayout}>
                    <div className={styles.contactList} aria-label="Saved contacts">
                      {contacts.length === 0 ? <p className={styles.emptyList}>No contacts saved yet.</p> : contacts.map((item) => <button type="button" key={item.id} disabled={locked} className={styles.contactChoice + (contactDraft?.id === item.id ? " " + styles.selectedChoice : "")} onClick={() => editContact(item)}><span className={styles.contactBadge}>{item.displayName.slice(0, 1).toLocaleUpperCase("en")}</span><span className={styles.contactText}><strong>{item.displayName}</strong><small>{item.phoneE164}</small><span>{item.isHost && <em>Host</em>}{!item.active && <em className={styles.archived}>Archived</em>}</span></span><Pencil size={15} aria-hidden="true" /></button>)}
                    </div>
                    <div className={styles.contactEditor}>
                      {!contactDraft ? <div className={styles.selectPrompt}><span className={styles.iconBadge}><ShieldCheck size={20} aria-hidden="true" /></span><h3>Select a contact</h3><p>Choose a saved contact to edit or add a new one.</p>{contacts.length === 0 && <Button type="button" variant="outline" onClick={startNewContact}><Plus size={15} aria-hidden="true" /> Add first contact</Button>}</div> : <>
                        <div className={styles.selectedHeading}><div><p className={styles.eyebrow}>{contactDraft.id ? "EDIT CONTACT" : "NEW CONTACT"}</p><h3>{contactDraft.displayName || "Contact details"}</h3></div><button type="button" className={styles.closeButton} disabled={locked} onClick={() => setContactDraft(null)}>Close</button></div>
                        {contactDraft.conflict && <div className={styles.conflictBox} role="alert"><strong>Contact changed while you were editing.</strong><span>Your inputs are preserved. Review current values before saving again.</span>{contactDraft.id && contacts.find((item) => item.id === contactDraft.id) && <dl className={styles.latestReview}><div><dt>Saved name</dt><dd>{contacts.find((item) => item.id === contactDraft.id)?.displayName}</dd></div><div><dt>Saved phone</dt><dd>{contacts.find((item) => item.id === contactDraft.id)?.phoneE164}</dd></div><div><dt>Host / active</dt><dd>{contacts.find((item) => item.id === contactDraft.id)?.isHost ? "Host" : "Not host"} · {contacts.find((item) => item.id === contactDraft.id)?.active ? "Active" : "Archived"}</dd></div></dl>}<Button type="button" variant="outline" size="sm" disabled={pending || uncertain !== null} onClick={adoptContactVersion}>Use latest version</Button></div>}
                        <form className={styles.form} onSubmit={submitContact}>
                          <label className={styles.field}><span>Display name</span><input type="text" minLength={1} maxLength={80} required value={contactDraft.displayName} disabled={locked} onChange={(event) => changeContact((draft) => ({ ...draft, displayName: event.currentTarget.value }))} /></label>
                          <label className={styles.field}><span>Phone number</span><input type="tel" maxLength={64} required value={contactDraft.phoneE164} disabled={locked} onChange={(event) => changeContact((draft) => ({ ...draft, phoneE164: event.currentTarget.value }))} placeholder="+14155550123" /><small>Enter country code first. Common separators are accepted.</small></label>
                          <label className={styles.checkRow}><input type="checkbox" checked={contactDraft.isHost} disabled={locked} onChange={(event) => changeContact((draft) => ({ ...draft, isHost: event.currentTarget.checked, active: event.currentTarget.checked ? true : draft.active }))} /><span><strong>Designated host</strong><small>Only one active contact can be designated host.</small></span></label>
                          <label className={styles.checkRow}><input type="checkbox" checked={contactDraft.active} disabled={locked || contactDraft.isHost} onChange={(event) => changeContact((draft) => ({ ...draft, active: event.currentTarget.checked }))} /><span><strong>Active contact</strong><small>Turn off to archive this contact.</small></span></label>
                          <div className={styles.formActions}><Button type="submit" disabled={locked || contactDraft.conflict}>{pending ? "Saving…" : contactDraft.id ? "Save contact" : "Add contact"}</Button><Button type="button" variant="outline" disabled={locked} onClick={() => setContactDraft(null)}>Cancel</Button></div>
                        </form>
                      </>}
                    </div>
                  </div>
                </section>
              )}
            </>
          ) : <section className={styles.state} role="status"><Wine size={24} aria-hidden="true" /><h2>Host data unavailable</h2><p>Sign in to load the private dashboard.</p></section>}
          <footer className={styles.footer}><span>DINNER CELLAR</span><span>Private host tools.</span></footer>
        </div>
      </main>
    </div>
  );
}

