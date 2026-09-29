import { Children, cloneElement, isValidElement, useEffect, useState, type AriaAttributes, type MouseEvent, type MouseEventHandler, type ReactElement, type ReactNode } from "react";
import { Link, useLocation } from "react-router-dom";
import { Menu, Wine } from "lucide-react";
import { Button } from "./Button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "./Dialog";
import styles from "./CellarMenu.module.css";

type CellarMenuProps = {
  children: ReactNode;
  onNavigate?: MouseEventHandler<HTMLAnchorElement>;
  navigationDisabled?: boolean;
};

export default function CellarMenu({ children, onNavigate, navigationDisabled = false }: CellarMenuProps) {
  const { pathname } = useLocation();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  function handleNavigationClick(event: MouseEvent<HTMLElement>) {
    if (event.defaultPrevented) return;
    const target = event.target;
    if (target instanceof Element && target.closest("a")) setOpen(false);
  }

  function handleBrandClick(event: MouseEvent<HTMLAnchorElement>) {
    onNavigate?.(event);
    if (navigationDisabled) event.preventDefault();
    setOpen(false);
  }

  const navigationItems = Children.map(children, (child) => {
    if (!isValidElement(child)) return child;
    const props = child.props as Record<string, unknown>;

    if (child.type === Link) {
      const active = typeof props.to === "string" && props.to === pathname;
      return cloneElement(child as ReactElement<Record<string, unknown>>, {
        className: active ? styles.activeLink : styles.navLink,
        "aria-current": active ? "page" : undefined,
        onClick: (event: MouseEvent<HTMLAnchorElement>) => {
          const original = props.onClick as MouseEventHandler<HTMLAnchorElement> | undefined;
          original?.(event);
          setOpen(false);
        },
      });
    }

    if (child.type === "span") {
      const active = props["aria-current"] === "page";
      return cloneElement(child as ReactElement<Record<string, unknown>>, {
        className: active ? styles.activeLink : styles.navLink,
        "aria-current": props["aria-current"] as AriaAttributes["aria-current"],
      });
    }

    return child;
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <header className={styles.launcherBar}>
        <strong className={styles.launcherBrand}>Dinner Cellar</strong>
        <DialogTrigger asChild>
          <Button type="button" variant="ghost" className={styles.trigger} aria-label="Open navigation menu">
            <Menu size={21} aria-hidden="true" />
          </Button>
        </DialogTrigger>
      </header>
      <DialogContent className={styles.drawer} aria-describedby={undefined}>
        <DialogHeader className={styles.header}>
          <Link to="/" className={styles.brand} aria-disabled={navigationDisabled} onClick={handleBrandClick}>
            <span className={styles.brandIcon}><Wine size={21} aria-hidden="true" /></span>
            <span className={styles.brandText}><strong>Dinner Cellar</strong><small>A private collection</small></span>
          </Link>
          <DialogTitle className={styles.title}>Cellar menu</DialogTitle>
        </DialogHeader>
        <nav className={styles.navigation} aria-label="Main navigation" onClick={handleNavigationClick}>
          <p className={styles.caption}>CELLAR</p>
          <div className={styles.links}>{navigationItems}</div>
          <p className={styles.note}>Shared with care.<br />Kept within your cellar.</p>
        </nav>
      </DialogContent>
    </Dialog>
  );
}
