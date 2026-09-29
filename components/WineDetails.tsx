import React, { useRef } from "react";
import { MapPin, Wine } from "lucide-react";
import type { CatalogWine } from "../helpers/wineCatalog";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "./Dialog";
import styles from "./WineDetails.module.css";

type WineDetailsProps = {
  wine: CatalogWine;
  onClose: () => void;
  onAddToCart: (quantity: number) => void;
  cartQuantity: number;
  canAdd: boolean;
};

const detailFields: Array<{ label: string; key: keyof CatalogWine }> = [
  { label: "Producer", key: "producer" },
  { label: "Wine", key: "wineName" },
  { label: "Vintage", key: "vintage" },
  { label: "Country", key: "country" },
  { label: "Region", key: "region" },
  { label: "Subregion", key: "subregion" },
  { label: "Appellation", key: "appellation" },
  { label: "Grape / blend", key: "grapeBlend" },
  { label: "Colour", key: "colour" },
  { label: "Wine style", key: "wineStyle" },
  { label: "Sweetness", key: "sweetness" },
];

function bottleSize(value: number) {
  return value.toLocaleString() + " mL";
}

export default function WineDetails({ wine, onClose, onAddToCart, cartQuantity, canAdd }: WineDetailsProps) {
  const titleRef = useRef<HTMLHeadingElement>(null);
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className={styles.dialog} onOpenAutoFocus={(event) => {
        event.preventDefault();
        titleRef.current?.focus({ preventScroll: true });
      }} onCloseAutoFocus={(event) => event.preventDefault()}>
        <section className={styles.panel}>
          <header className={styles.header}>
            <div>
              <p className={styles.eyebrow}>WINE DETAILS</p>
              <DialogTitle ref={titleRef} tabIndex={-1} className={styles.title}>{wine.producer} · {wine.wineName}</DialogTitle>
              <DialogDescription className={styles.visuallyHidden}>
                Wine information, stock locations, and cart quantity.
              </DialogDescription>
            </div>
          </header>

          <div className={styles.body}>
            <div className={styles.photo}>
              {wine.photoPath ? <img src={wine.photoPath} alt="" loading="lazy" onError={(event) => { event.currentTarget.hidden = true; }} /> : <Wine size={34} aria-hidden="true" />}
            </div>

            <dl className={styles.metadata}>
              {detailFields.map(({ key, label }) => {
                const value = wine[key];
                return <div className={styles.metaRow} key={key}><dt>{label}</dt><dd>{typeof value === "string" && value.trim() ? value : "Not recorded"}</dd></div>;
              })}
              <div className={styles.metaRow}><dt>Bottle size</dt><dd>{bottleSize(wine.bottleSizeMl)}</dd></div>
              <div className={styles.metaRow}><dt>Total bottles across cellar</dt><dd>{wine.totalQuantity}</dd></div>
            </dl>

            <section className={styles.locations} aria-labelledby="wine-locations-title">
              <div className={styles.locationHeading}><MapPin size={16} aria-hidden="true" /><h3 id="wine-locations-title">Where it rests</h3></div>
              {wine.locations.length === 0 ? <p className={styles.noLocations}>No current stock is recorded.</p> : (
                <ul>
                  {wine.locations.map((location) => <li key={location.locationId}><span>{location.fridge} <span aria-hidden="true">·</span> {location.shelf}</span><strong>{location.quantity} {location.quantity === 1 ? "bottle" : "bottles"}</strong></li>)}
                </ul>
              )}
            </section>

            <section className={styles.cartControls} aria-label="Cart quantity">
              <p>In your cart <strong aria-live="polite">{cartQuantity}</strong></p>
              <button type="button" className={styles.addButton} disabled={!canAdd} onClick={() => onAddToCart(1)}>Add 1 bottle</button>
            </section>
          </div>
        </section>
      </DialogContent>
    </Dialog>
  );
}
