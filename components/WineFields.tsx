import { useId } from "react";
import { categoryFields, type CategoryKey } from "../helpers/wineCatalog";
import type { WineInput } from "../helpers/inventoryPolicy";
import styles from "./WineFields.module.css";

export type WineFieldsProps = {
  value: WineInput;
  onChange: (value: WineInput) => void;
  categories: Record<CategoryKey, string[]>;
  disabled?: boolean;
};

const fieldForKey: Record<CategoryKey, keyof WineInput> = {
  producer: "producer",
  wineName: "wineName",
  vintage: "vintage",
  country: "country",
  region: "region",
  subregion: "subregion",
  appellation: "appellation",
  grapeBlend: "grapeBlend",
  colour: "colour",
  wineStyle: "wineStyle",
  sweetness: "sweetness",
  bottleSizeMl: "bottleSizeMl",
};

const requiredFields = new Set<CategoryKey>(["producer", "wineName", "bottleSizeMl"]);

export function WineFields({ value, onChange, categories, disabled = false }: WineFieldsProps) {
  const idPrefix = useId();
  const updateText = (key: keyof WineInput, raw: string) => {
    const normalized = raw.trim();
    const requiredText = key === "producer" || key === "wineName";
    onChange({ ...value, [key]: normalized.length === 0 && !requiredText ? null : raw });
  };
  const updateSize = (raw: string) => {
    const parsed = raw === "" ? 0 : Number(raw);
    onChange({ ...value, bottleSizeMl: Number.isFinite(parsed) ? parsed : 0 });
  };

  return (
    <div className={styles.grid}>
      {categoryFields.map(({ key, label }, index) => {
        const id = `${idPrefix}-${key}`;
        const valueKey = fieldForKey[key];
        const datalistId = `${id}-options`;
        const isSize = key === "bottleSizeMl";
        const rawValue = isSize ? String(value.bottleSizeMl || "") : String(value[valueKey] ?? "");
        return (
          <div className={styles.field} key={key}>
            <label htmlFor={id}>{label}{requiredFields.has(key) && <span aria-hidden="true"> *</span>}</label>
            {isSize ? (
              <>
                <input
                  id={id}
                  name={key}
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={2147483647}
                  step={1}
                  required
                  disabled={disabled}
                  value={rawValue}
                  onChange={(event) => updateSize(event.currentTarget.value)}
                  autoComplete="off"
                  list={datalistId}
                />
                <datalist id={datalistId}>
                  {(categories[key] ?? []).map((option) => <option key={`${option}-${index}`} value={option} />)}
                </datalist>
              </>
            ) : (
              <>
                <input
                  id={id}
                  name={key}
                  type="text"
                  maxLength={300}
                  required={requiredFields.has(key)}
                  disabled={disabled}
                  value={rawValue}
                  onChange={(event) => updateText(valueKey, event.currentTarget.value)}
                  list={datalistId}
                  autoComplete="off"
                />
                <datalist id={datalistId}>
                  {(categories[key] ?? []).map((option) => <option key={`${option}-${index}`} value={option} />)}
                </datalist>
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}
