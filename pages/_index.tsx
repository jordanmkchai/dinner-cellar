import React from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { LockKeyhole, Wine } from "lucide-react";
import { Button } from "../components/Button";
import { getCellarSummary } from "../endpoints/cellar/summary_GET.schema";
import CellarMenu from "../components/CellarMenu";
import styles from "./_index.module.css";

export default function IndexPage() {
  const query = useQuery({ queryKey: ["cellar-summary"], queryFn: () => getCellarSummary(), retry: false, refetchOnMount: "always" });
  const summary = query.data;
  return (
    <div className={styles.frame}>
      <CellarMenu>
          <Link to="/">Overview</Link>
          <Link to="/wines">Wine inventory</Link>
          {summary && !query.isFetching && !query.isError && <Link to="/cart">Cart</Link>}
          {summary?.role === "host" && !query.isFetching && !query.isError && <Link to="/host-dashboard">Host dashboard</Link>}
          {summary?.role === "host" && !query.isFetching && !query.isError && <Link to="/host-checkouts">Checkouts</Link>}
          {summary?.role === "host" && !query.isFetching && !query.isError && <Link to="/host-access">Host access</Link>}
        
      </CellarMenu>
      <main className={styles.main}>
        <header className={styles.topbar}><span>YOUR CELLAR　/　OVERVIEW</span><span className={styles.privacy}>PRIVATE ACCESS</span></header>
        <div className={styles.content}>
          <p className={styles.eyebrow}>A WELL-KEPT COLLECTION</p>
          <h1>A cellar worth<br />remembering.</h1>
          <p className={styles.intro}>A clear view of the wines, bottles, and places that make dinner special.</p>
          {query.isPending || query.isFetching ? (
            <section className={styles.state}><Wine size={23} /><h2>Opening the cellar</h2><p>Checking your private access…</p><div className={styles.loadingBar} /></section>
          ) : query.isError ? (
            <section className={styles.state}><h2>Cellar summary unavailable</h2><p>We could not load this private collection.</p><Button variant="outline" onClick={() => void query.refetch()}>Try again</Button></section>
          ) : !summary ? (
            <section className={`${styles.state} ${styles.gate}`}><span className={styles.lockBadge}><LockKeyhole size={20} /></span><p className={styles.eyebrow}>PRIVATE COLLECTION</p><h2>This cellar is kept private.</h2><p>Sign in as the host, or open the private guest link shared with you to view the collection.</p><Button asChild className={styles.signIn}><Link to="/login">Host sign in <span aria-hidden="true">→</span></Link></Button><p><Link to="/setup">First-time host setup</Link></p></section>
          ) : (
            <>
              <section className={styles.stats} aria-label="Cellar summary">
                <article className={styles.featured}><span>WINE LABELS</span><strong>{summary.wineCount}</strong><small>Distinct wines</small></article>
                <article><span>BOTTLES</span><strong>{summary.bottleCount}</strong><small>Available to share</small></article>
                <article><span>FRIDGES</span><strong>{summary.fridges.length}</strong><small>Storage locations</small></article>
                <article><span>SHELVES</span><strong>{summary.fridges.reduce((n, fridge) => n + fridge.shelves.length, 0)}</strong><small>Across all fridges</small></article>
              </section>
              <section className={styles.storage}><div className={styles.sectionHead}><div><p className={styles.eyebrow}>WHERE IT RESTS</p><h2>Storage map</h2></div><span>{summary.role === "host" ? "HOST" : "GUEST"} ACCESS</span></div>
                {summary.fridges.length === 0 ? <div className={styles.empty}>No fridge locations in this cellar yet.</div> : <div className={styles.fridges}>{summary.fridges.map(fridge => <article className={styles.fridge} key={fridge.name}><div className={styles.fridgeTop}><span>FRIDGE</span><strong>{fridge.bottleCount} bottles</strong></div><h3>{fridge.name}</h3><p>{fridge.wineCount} wines · {fridge.shelves.length} shelves</p>{fridge.shelves.map(shelf => <div className={styles.shelf} key={`${fridge.name}-${shelf.label}`}><span>{shelf.label}</span><small>{shelf.bottleCount} bottles</small></div>)}</article>)}</div>}
              </section>
            </>
          )}
          <footer className={styles.footer}><span>DINNER CELLAR</span><span>Shared for the table, kept with care.</span></footer>
        </div>
      </main>
    </div>
  );
}
