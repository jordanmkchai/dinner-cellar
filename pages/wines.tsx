import React, { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { ArrowLeft, ChevronDown, LockKeyhole, MapPin, RotateCcw, Search, ShoppingBasket, Wine } from "lucide-react";
import { Button } from "../components/Button";
import { Input } from "../components/Input";
import WineDetails from "../components/WineDetails";
import AddWineDialog from "../components/AddWineDialog";
import { catalogOptions, categoryFields, emptyCatalogFilters, filterCatalog } from "../helpers/wineCatalog";
import { getCartContext } from "../endpoints/cellar/cart-context_GET.schema";
import { addCartLine, cartBottleCount } from "../helpers/cartPolicy";
import { resetPrivateCart, useCart } from "../helpers/cartStore";
import type { CatalogFilters, CatalogWine, CategoryKey } from "../helpers/wineCatalog";
import CellarMenu from "../components/CellarMenu";
import styles from "./wines.module.css";

function locationLabel(wine: CatalogWine) {
  if (wine.locations.length === 0) return "No current stock";
  return wine.locations.map((location) => location.fridge + " · " + location.shelf).join(", ");
}

function BottleCount({ count }: { count: number }) {
  return <>{count} {count === 1 ? "bottle" : "bottles"}</>;
}

export default function WinesPage() {
  const [addOpen, setAddOpen] = useState(false);
  const [filters, setFilters] = useState<CatalogFilters>(() => emptyCatalogFilters());
  const [advancedFiltersOpen, setAdvancedFiltersOpen] = useState(false);
  const [selectedQuantities, setSelectedQuantities] = useState<Record<string, number>>({});
  const [selectedWineId, setSelectedWineId] = useState<string | null>(null);
  const [cartNotice, setCartNotice] = useState("");
  const detailsTrigger = useRef<HTMLButtonElement | null>(null);
  const query = useQuery({
    queryKey: ["cart-context"],
    queryFn: ({ signal }) => getCartContext({ signal }),
    retry: false,
    staleTime: 0,
    refetchOnMount: "always",
    refetchOnWindowFocus: !addOpen,
    refetchOnReconnect: !addOpen,
  });

  const currentContext = !query.isFetching && !query.isError ? query.data ?? null : null;
  const cart = useCart(currentContext?.scope ?? null);
  const accessStatus = typeof query.error === "object" && query.error !== null && "status" in query.error ? query.error.status : undefined;
  const denied = (!query.isFetching && !query.isError && query.data === null) || (query.isError && (accessStatus === 401 || accessStatus === 403));
  useEffect(() => { if (denied) resetPrivateCart(); }, [denied]);

  const currentWines = currentContext?.wines ?? [];
  const visibleWines = useMemo(() => filterCatalog(currentWines, filters), [currentWines, filters]);
  const options = useMemo(() => catalogOptions(currentWines, filters), [currentWines, filters]);
  const selectedWine = selectedWineId ? currentWines.find((wine) => wine.id === selectedWineId) ?? null : null;
  const resultBottles = visibleWines.reduce((sum, wine) => sum + wine.totalQuantity, 0);
  const cartReady = Boolean(currentContext && cart.persistence !== "loading");
  const cartCount = cartReady ? cartBottleCount(cart.draft) : 0;

  function changeCategory(key: CategoryKey, value: string) {
    setFilters((current) => ({ ...current, categories: { ...current.categories, [key]: value } }));
  }

  function openDetails(event: React.MouseEvent<HTMLButtonElement>, wineId: string) {
    detailsTrigger.current = event.currentTarget;
    setSelectedWineId(wineId);
  }

  function closeDetails() {
    const trigger = detailsTrigger.current;
    setSelectedWineId(null);
    window.requestAnimationFrame(() => trigger?.focus({ preventScroll: true }));
  }

  function addToCart(wineId: string, amount = 1): boolean {
    if (!cartReady) return false;
    const wine = currentWines.find((candidate) => candidate.id === wineId);
    if (!wine) return false;
    try {
      const next = addCartLine(cart.draft, wineId, amount, currentWines);
      cart.save(next);
      setCartNotice(`${amount} ${amount === 1 ? "bottle" : "bottles"} of ${wine.wineName} added to cart.`);
      return true;
    } catch (error) {
      setCartNotice(error instanceof Error ? error.message : "Bottle could not be added.");
      return false;
    }
  }

  function cartQuantity(wineId: string): number {
    return cart.draft.lines.find((line) => line.wineId === wineId)?.quantity ?? 0;
  }

  function remainingQuantity(wine: CatalogWine): number {
    return Math.max(0, wine.totalQuantity - cartQuantity(wine.id));
  }

  function selectedQuantity(wine: CatalogWine): number {
    const remaining = remainingQuantity(wine);
    return Math.min(selectedQuantities[wine.id] ?? 1, remaining);
  }

  function changeSelectedQuantity(wine: CatalogWine, change: number) {
    const remaining = remainingQuantity(wine);
    if (remaining === 0) return;
    setSelectedQuantities((current) => {
      const selected = Math.min(current[wine.id] ?? 1, remaining);
      return { ...current, [wine.id]: Math.max(1, Math.min(remaining, selected + change)) };
    });
  }

  function addSelectedQuantity(wine: CatalogWine) {
    const amount = selectedQuantity(wine);
    if (amount > 0 && addToCart(wine.id, amount)) {
      setSelectedQuantities((current) => ({ ...current, [wine.id]: 1 }));
    }
  }

  const isLoading = query.isPending || query.isFetching;
  const currentRole = currentContext?.role;

  return (
    <div className={styles.frame}>
      <CellarMenu>
          <Link to="/">Overview</Link>
          <Link to="/wines" aria-current="page">Wine inventory</Link>
          <Link to="/cart">Cart{cartReady ? ` · ${cartCount}` : ""}</Link>
          {currentRole === "host" && <Link to="/host-access">Host access</Link>}
          {currentRole === "host" && <Link to="/host-dashboard">Host dashboard</Link>}
        
      </CellarMenu>

      <main className={styles.main}>
        <header className={styles.topbar}><span>YOUR CELLAR　/　INVENTORY</span><span className={styles.privacy}>PRIVATE ACCESS</span></header>
        <div className={styles.content}>
          <Link to="/" className={styles.backLink}><ArrowLeft size={14} aria-hidden="true" /> Overview</Link>
          <p className={styles.eyebrow}>A WELL-KEPT COLLECTION</p>
          <h1>Wines for the table.</h1>
          <p className={styles.intro}>Browse every label, see what is available, and find each bottle in the cellar.</p>

          {isLoading ? (
            <section className={styles.state} role="status" aria-live="polite"><Wine size={24} aria-hidden="true" /><h2>Opening the cellar</h2><p>Checking your private access and refreshing the collection…</p><div className={styles.loadingBar} /></section>
          ) : query.isError ? (
            <section className={styles.state} role="alert"><Wine size={24} aria-hidden="true" /><h2>Wine inventory unavailable</h2><p>We could not load this private collection. Your wines and stock stay hidden until access can be checked.</p><Button variant="outline" onClick={() => void query.refetch()}>Try again</Button></section>
          ) : !currentContext ? (
            <section className={`${styles.state} ${styles.gate}`}><span className={styles.lockBadge}><LockKeyhole size={20} aria-hidden="true" /></span><p className={styles.eyebrow}>PRIVATE COLLECTION</p><h2>This cellar is kept private.</h2><p>Sign in as the host, or open the private guest link shared by your host to view its wines.</p><Button asChild className={styles.signIn}><Link to="/login">Host sign in <span aria-hidden="true">→</span></Link></Button></section>
          ) : (
            <>
              {cart.persistence === "memory" && <p className={styles.cartNotice} role="status">Browser storage is unavailable. Cart stays in memory until this page closes.</p>}
              <div className={styles.inventoryActions}><Button onClick={() => setAddOpen(true)}>Add wine / restock</Button><Button asChild variant="outline"><Link to="/cart"><ShoppingBasket size={15} aria-hidden="true" /> Cart · {cartCount}</Link></Button></div>
              {cartNotice && <p className={styles.cartNotice} role="status" aria-live="polite">{cartNotice}</p>}
              <AddWineDialog open={addOpen} onClose={() => setAddOpen(false)} onSaved={() => setAddOpen(false)} wines={currentWines} />
              <section className={styles.filterPanel} aria-label="Wine filters">
                <div className={styles.searchRow}>
                  <label className={styles.searchField} htmlFor="wine-search"><span>Search wines</span><span className={styles.inputWrap}><Search size={16} aria-hidden="true" /><Input id="wine-search" type="search" value={filters.search} onChange={(event) => setFilters((current) => ({ ...current, search: event.target.value }))} placeholder="Producer, wine, grape or blend" /></span></label>
                </div>
                <Button type="button" variant="outline" size="sm" className={styles.advancedToggle} aria-expanded={advancedFiltersOpen} aria-controls="advanced-wine-filters" onClick={() => setAdvancedFiltersOpen((open) => !open)}>
                  Advanced filters <ChevronDown size={15} aria-hidden="true" className={advancedFiltersOpen ? styles.advancedIconOpen : styles.advancedIcon} />
                </Button>
                {advancedFiltersOpen && <div className={styles.advancedFilters} id="advanced-wine-filters">
                  <div className={styles.advancedTopRow}>
                    <label className={styles.availableToggle}><input type="checkbox" checked={filters.availableOnly} onChange={(event) => setFilters((current) => ({ ...current, availableOnly: event.target.checked }))} /><span><strong>Available only</strong><small>On by default</small></span></label>
                    <Button type="button" variant="outline" size="sm" className={styles.reset} onClick={() => setFilters(emptyCatalogFilters())}><RotateCcw size={14} aria-hidden="true" /> Reset filters</Button>
                  </div>
                  <div className={styles.filterGrid}>
                    {categoryFields.map(({ key, label }) => <label className={styles.filterField} key={key} htmlFor={"wine-filter-" + key}><span>{label}</span><select id={"wine-filter-" + key} value={filters.categories[key] ?? ""} onChange={(event) => changeCategory(key, event.target.value)}><option value="">All {label.toLowerCase()}</option>{options.categories[key].map((value) => <option value={value} key={value}>{value}</option>)}</select></label>)}
                    <label className={styles.filterField} htmlFor="wine-filter-fridge"><span>Fridge</span><select id="wine-filter-fridge" value={filters.fridge} onChange={(event) => setFilters((current) => ({ ...current, fridge: event.target.value, shelf: "" }))}><option value="">All fridges</option>{options.fridges.map((fridge) => <option value={fridge} key={fridge}>{fridge}</option>)}</select></label>
                    <label className={styles.filterField} htmlFor="wine-filter-shelf"><span>Shelf</span><select id="wine-filter-shelf" value={filters.shelf} onChange={(event) => setFilters((current) => ({ ...current, shelf: event.target.value }))}><option value="">All shelves</option>{options.shelves.map((shelf) => <option value={shelf} key={shelf}>{shelf}</option>)}</select></label>
                  </div>
                  <p className={styles.filterHint}>Fridge and shelf select wines stocked together in that location. Bottle totals always include all cellar locations.</p>
                </div>}
              </section>

              <section className={styles.results} aria-labelledby="wine-results-title">
                <div className={styles.resultsHeading}>
                  <div><p className={styles.eyebrow}>THE CELLAR</p><h2 id="wine-results-title">Wine inventory</h2></div>
                  <div className={styles.counts}><strong>{visibleWines.length}</strong> of {currentWines.length} labels <span aria-hidden="true">·</span> <strong>{resultBottles}</strong> total bottles across matching labels</div>
                </div>

                {currentWines.length === 0 ? (
                  <div className={styles.empty}><Wine size={23} aria-hidden="true" /><h3>No wines in this cellar yet</h3><p>New labels will appear here when they are added to the private collection.</p></div>
                ) : visibleWines.length === 0 ? (
                  <div className={styles.empty}><Search size={22} aria-hidden="true" /><h3>No wines match these filters</h3><p>Try a shorter search or reset your filters. Turn off Available only to include wines with no current stock.</p><Button variant="outline" size="sm" onClick={() => setFilters(emptyCatalogFilters())}>Reset filters</Button></div>
                ) : (
                  <>
                    <div className={styles.tableWrap}>
                      <table className={styles.table}>
                        <caption className={styles.srOnly}>Wine inventory. Select View details to see all wine and storage information.</caption>
                        <thead><tr><th scope="col">Wine</th><th scope="col">Vintage</th><th scope="col">Region</th><th scope="col">Grape / blend</th><th scope="col">Total bottles</th><th scope="col">Location</th><th scope="col">Cart</th><th scope="col"><span className={styles.srOnly}>Details</span></th></tr></thead>
                        <tbody>{visibleWines.map((wine) => <tr key={wine.id}>
                          <th scope="row"><div className={styles.wineCell}><div className={styles.thumbnail}>{wine.photoPath ? <img src={wine.photoPath} alt="" loading="lazy" onError={(event) => { event.currentTarget.hidden = true; }} /> : <Wine size={19} aria-hidden="true" />}</div><span><strong>{wine.wineName}</strong><small>{wine.producer}</small></span></div></th>
                          <td>{wine.vintage || "—"}</td>
                          <td>{wine.region || wine.country || "—"}</td>
                          <td>{wine.grapeBlend || "—"}</td>
                          <td><span className={`${styles.quantity} ${wine.totalQuantity === 0 ? styles.outOfStock : ""}`}><BottleCount count={wine.totalQuantity} /></span></td>
                          <td className={styles.locationCell}>{wine.locations.length === 0 ? <span className={styles.muted}>No current stock</span> : wine.locations.map((location) => <span key={location.locationId}>{location.fridge} · {location.shelf}</span>)}</td>
                          <td><div className={styles.cartActions}><div className={styles.quantityPicker} role="group" aria-label={`Quantity to add for ${wine.wineName}`}><button type="button" className={styles.quantityButton} aria-label={`Decrease quantity of ${wine.wineName}`} onClick={() => changeSelectedQuantity(wine, -1)} disabled={!cartReady || selectedQuantity(wine) <= 1}>−</button><output className={styles.quantityValue} aria-live="polite">{selectedQuantity(wine)}</output><button type="button" className={styles.quantityButton} aria-label={`Increase quantity of ${wine.wineName}`} onClick={() => changeSelectedQuantity(wine, 1)} disabled={!cartReady || selectedQuantity(wine) >= remainingQuantity(wine)}>+</button></div><Button size="sm" variant="outline" onClick={() => addSelectedQuantity(wine)} disabled={!cartReady || remainingQuantity(wine) === 0}>Add {selectedQuantity(wine)}</Button></div></td>
                          <td><button type="button" className={styles.detailButton} onClick={(event) => openDetails(event, wine.id)}>View details</button></td>
                        </tr>)}</tbody>
                      </table>
                    </div>

                    <div className={styles.mobileCards}>
                      {visibleWines.map((wine) => <article className={styles.wineCard} key={wine.id}>
                        <div className={styles.cardTop}><span className={styles.thumbnail}>{wine.photoPath ? <img src={wine.photoPath} alt="" loading="lazy" onError={(event) => { event.currentTarget.hidden = true; }} /> : <Wine size={20} aria-hidden="true" />}</span><span className={styles.cardName}><strong>{wine.wineName}</strong><small>{wine.producer}</small></span><span className={`${styles.quantity} ${wine.totalQuantity === 0 ? styles.outOfStock : ""}`}><BottleCount count={wine.totalQuantity} /></span></div>
                        <div className={styles.cardFacts}><span><small>Vintage</small><strong>{wine.vintage || "—"}</strong></span><span><small>Region</small><strong>{wine.region || wine.country || "—"}</strong></span><span><small>Grape / blend</small><strong>{wine.grapeBlend || "—"}</strong></span></div>
                        <div className={styles.cardLocation}><MapPin size={14} aria-hidden="true" /><span>{locationLabel(wine)}</span></div>
                        <div className={styles.cardActions}><button type="button" className={styles.detailButton} onClick={(event) => openDetails(event, wine.id)}>View details</button><div className={styles.cartActions}><div className={styles.quantityPicker} role="group" aria-label={`Quantity to add for ${wine.wineName}`}><button type="button" className={styles.quantityButton} aria-label={`Decrease quantity of ${wine.wineName}`} onClick={() => changeSelectedQuantity(wine, -1)} disabled={!cartReady || selectedQuantity(wine) <= 1}>−</button><output className={styles.quantityValue} aria-live="polite">{selectedQuantity(wine)}</output><button type="button" className={styles.quantityButton} aria-label={`Increase quantity of ${wine.wineName}`} onClick={() => changeSelectedQuantity(wine, 1)} disabled={!cartReady || selectedQuantity(wine) >= remainingQuantity(wine)}>+</button></div><Button size="sm" variant="outline" onClick={() => addSelectedQuantity(wine)} disabled={!cartReady || remainingQuantity(wine) === 0}>Add {selectedQuantity(wine)} to cart</Button></div></div>
                      </article>)}
                    </div>
                  </>
                )}
              </section>

              {selectedWine && <WineDetails wine={selectedWine} onClose={closeDetails} onAddToCart={(quantity) => addToCart(selectedWine.id, quantity)} cartQuantity={cartQuantity(selectedWine.id)} canAdd={cartReady && selectedWine.totalQuantity > cartQuantity(selectedWine.id)} />}
            </>
          )}

          <footer className={styles.footer}><span>DINNER CELLAR</span><span>Shared for the table, kept with care.</span></footer>
        </div>
      </main>
    </div>
  );
}
