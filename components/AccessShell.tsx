import React from "react";
import { Link } from "react-router-dom";
import { Wine } from "lucide-react";
import styles from "./AccessShell.module.css";

type AccessShellProps = {
  eyebrow: string;
  title: string;
  description: string;
  children: React.ReactNode;
  className?: string;
};

export default function AccessShell({ eyebrow, title, description, children, className }: AccessShellProps) {
  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <Link to="/" className={styles.brand} aria-label="Dinner Cellar home">
          <span className={styles.brandIcon}><Wine size={20} aria-hidden="true" /></span>
          <span>Dinner Cellar</span>
        </Link>
        <span className={styles.headerNote}>PRIVATE COLLECTION</span>
      </header>
      <main className={`${styles.panel} ${className ?? ""}`}>
        <div className={styles.panelMark} aria-hidden="true" />
        <p className={styles.eyebrow}>{eyebrow}</p>
        <h1>{title}</h1>
        <p className={styles.description}>{description}</p>
        <div className={styles.body}>{children}</div>
      </main>
      <footer className={styles.footer}><span>DINNER CELLAR</span><span>Kept with care, shared for the table.</span></footer>
    </div>
  );
}
