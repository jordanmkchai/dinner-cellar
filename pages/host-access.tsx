import React, { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, Copy, Link2, LockKeyhole, LogOut, Plus, ShieldCheck, X } from "lucide-react";
import { Button } from "../components/Button";
import { getGuestLinks } from "../endpoints/access/guest-links_GET.schema";
import { postCreateGuestLink } from "../endpoints/access/guest-links/create_POST.schema";
import { postRevokeGuestLink } from "../endpoints/access/guest-links/revoke_POST.schema";
import { useAuth } from "../helpers/useAuth";
import AccessShell from "../components/AccessShell";
import styles from "./host-access.module.css";

type CreatedLink = { id: string; path: string };

function formatCreatedAt(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Date unavailable" : date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export default function HostAccessPage() {
  const navigate = useNavigate();
  const { logout } = useAuth();
  const queryClient = useQueryClient();
  const [createdLink, setCreatedLink] = useState<CreatedLink | null>(null);
  const [copied, setCopied] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState("");
  const query = useQuery({ queryKey: ["guest-links"], queryFn: () => getGuestLinks(), retry: false, refetchOnMount: "always" });
  const createMutation = useMutation({
    mutationFn: () => postCreateGuestLink({}),
    onSuccess: (result) => {
      setCreatedLink(result.link);
      setCopied(false);
      void queryClient.invalidateQueries({ queryKey: ["guest-links"] });
    },
  });
  const revokeMutation = useMutation({
    mutationFn: (id: string) => postRevokeGuestLink({ id }),
    onSuccess: () => {
      setCreatedLink(null);
      void queryClient.invalidateQueries({ queryKey: ["guest-links"] });
    },
  });

  const shareUrl = useMemo(() => {
    if (!createdLink || typeof window === "undefined") return null;
    try {
      const url = new URL(createdLink.path, window.location.origin);
      if (url.origin !== window.location.origin) return null;
      return url;
    } catch {
      return null;
    }
  }, [createdLink]);
  const isPreviewOrigin = typeof window !== "undefined" && (
    /(^|\.)sandbox\.floot\.app$/i.test(window.location.hostname) || window.self !== window.top
  );

  async function copyInvite() {
    if (!shareUrl) return;
    try {
      await navigator.clipboard.writeText(shareUrl.href);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  async function signOut() {
    if (signingOut) return;
    setSigningOut(true);
    setSignOutError("");
    try {
      await logout();
      navigate("/", { replace: true });
    } catch {
      setSignOutError("Could not sign out. Try again.");
    } finally {
      setSigningOut(false);
    }
  }

  if (query.isPending || query.isFetching) {
    return <AccessShell eyebrow="HOST ACCESS" title="Your cellar, in trusted hands." description="Manage private guest access for Dinner Cellar."><p className={styles.loading}>Loading host access…</p></AccessShell>;
  }
  if (query.isError) {
    return <AccessShell eyebrow="HOST ACCESS" title="Sign in to continue." description="Guest links and host settings are only visible to the cellar host."><div className={styles.gate}><LockKeyhole size={19} /><p>Host access required.</p><Button asChild><Link to="/login">Host sign in <ArrowRight size={15} /></Link></Button></div></AccessShell>;
  }

  const links = query.data?.links ?? [];
  const createError = createMutation.error instanceof Error ? createMutation.error.message : "Could not create guest link.";
  const revokeError = revokeMutation.error instanceof Error ? revokeMutation.error.message : "Could not close guest link.";

  return (
    <AccessShell eyebrow="HOST ACCESS" title="Your cellar, in trusted hands." description="Create private invitations for guests, and close access when dinner is done." className={styles.shell}>
      <section className={styles.createPanel}>
        <span className={styles.createIcon}><Link2 size={18} aria-hidden="true" /></span>
        <div className={styles.createCopy}><h2>Invite someone to the cellar</h2><p>Share one link with several guests. It never expires. You can close it at any time.</p></div>
        <Button onClick={() => createMutation.mutate()} disabled={createMutation.isPending} className={styles.createButton}>
          <Plus size={16} aria-hidden="true" />{createMutation.isPending ? "Creating…" : "Create guest link"}
        </Button>
      </section>

      {createMutation.isError && <p className={styles.error} role="alert">{createError}</p>}
      {createdLink && (
        <section className={styles.newLink} aria-live="polite">
          <div className={styles.newLinkTitle}><ShieldCheck size={17} aria-hidden="true" /><strong>Private invitation ready</strong><span>Never expires; valid until you close it</span></div>
          {isPreviewOrigin ? <p className={styles.previewNote}>Preview links cannot be shared with guests. Create an invitation from the published cellar to get a usable private link.</p> : shareUrl ? (
            <div className={styles.copyRow}><code>{shareUrl.href}</code><Button variant="outline" onClick={() => void copyInvite()}><Copy size={15} aria-hidden="true" />{copied ? "Copied" : "Copy link"}</Button></div>
          ) : <p className={styles.previewNote}>This invitation is not available on the current app origin.</p>}
        </section>
      )}

      <div className={styles.signOutRow}>{signOutError && <p className={styles.error} role="alert">{signOutError}</p>}<Button variant="ghost" onClick={() => void signOut()} disabled={signingOut}><LogOut size={15} aria-hidden="true" />{signingOut ? "Signing out…" : "Sign out"}</Button></div>

      <section className={styles.linkSection}>
        <div className={styles.sectionHeading}><div><p className={styles.miniEyebrow}>INVITATIONS</p><h2>Guest links</h2></div><span>{links.filter((link) => link.active).length} ACTIVE</span></div>
        {links.length === 0 ? <div className={styles.empty}><LockKeyhole size={18} /><p>No guest links yet.</p><small>Create a private link when you are ready to invite someone.</small></div> : (
          <div className={styles.linkList}>
            {links.map((link) => <article className={styles.linkRow} key={link.id}>
              <div className={styles.linkMark} aria-hidden="true" />
              <div className={styles.linkInfo}><strong>{link.active ? "Active guest link" : "Inactive guest link"}</strong><span>Created {formatCreatedAt(link.createdAt)}</span><small>{link.revokedAt ? "Closed by host" : "Never expires"}</small></div>
              <span className={`${styles.status} ${link.active ? styles.statusActive : ""}`}>{link.active ? "ACTIVE" : "CLOSED"}</span>
              {link.active && <Button variant="outline" size="sm" className={styles.revokeButton} onClick={() => revokeMutation.mutate(link.id)} disabled={revokeMutation.isPending} aria-label="Close guest link"><X size={14} aria-hidden="true" /><span>Close</span></Button>}
            </article>)}
          </div>
        )}
        {revokeMutation.isError && <p className={styles.error} role="alert">{revokeError}</p>}
      </section>
      <div className={styles.bottomLinks}><Link to="/">Return to cellar overview</Link></div>
    </AccessShell>
  );
}
