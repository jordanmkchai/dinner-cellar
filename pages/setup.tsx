import React, { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowRight } from "lucide-react";
import { Button } from "../components/Button";
import { Input } from "../components/Input";
import { postSetup } from "../endpoints/access/setup_POST.schema";
import { useAuth } from "../helpers/useAuth";
import AccessShell from "../components/AccessShell";
import styles from "./setup.module.css";

export default function SetupPage() {
  const navigate = useNavigate();
  const { onLogin } = useAuth();
  const tokenRead = useRef(false);
  const [token, setToken] = useState("");
  const [manualToken, setManualToken] = useState("");
  const [ready, setReady] = useState(false);
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (tokenRead.current) return;
    tokenRead.current = true;
    const bootstrapToken = new URLSearchParams(window.location.hash.replace(/^#/, "")).get("token") ?? "";
    window.history.replaceState(window.history.state, "", `${window.location.pathname}${window.location.search}`);
    setToken(bootstrapToken);
    setReady(true);
  }, []);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const tokenToUse = token || manualToken.trim();
    if (!tokenToUse || busy) return;
    setBusy(true);
    setError("");
    try {
      const result = await postSetup({ token: tokenToUse, displayName, email, password });
      onLogin(result.user);
      navigate("/host-access", { replace: true });
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Host setup failed. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <AccessShell eyebrow="ONE-TIME HOST SETUP" title="Make this cellar yours." description="Create the host account for Dinner Cellar. This private setup link can be used once.">
      {!ready ? <p className={styles.note}>Checking your setup link…</p> : (         
        <form className={styles.form} onSubmit={(event) => void handleSubmit(event)}>
          {!token && <label className={styles.field} htmlFor="setup-code"><span>One-time setup code</span><Input id="setup-code" autoComplete="off" spellCheck={false} minLength={43} maxLength={43} pattern="[A-Za-z0-9_-]{43}" required value={manualToken} onChange={(event) => setManualToken(event.target.value)} /><small>Paste the private code provided for cellar setup.</small></label>}
          <label className={styles.field} htmlFor="display-name"><span>Your name</span><Input id="display-name" autoComplete="name" required maxLength={80} value={displayName} onChange={(event) => setDisplayName(event.target.value)} /></label>
          <label className={styles.field} htmlFor="setup-email"><span>Email</span><Input id="setup-email" type="email" autoComplete="email" required maxLength={254} value={email} onChange={(event) => setEmail(event.target.value)} /></label>
          <label className={styles.field} htmlFor="setup-password"><span>Password</span><Input id="setup-password" type="password" autoComplete="new-password" required minLength={12} maxLength={128} value={password} onChange={(event) => setPassword(event.target.value)} /><small>Use at least 12 characters.</small></label>
          {error && <p className={styles.error} role="alert">{error}</p>}
          <Button type="submit" disabled={busy || !(token || manualToken.trim()) || !displayName.trim() || !email.trim() || password.length < 12} className={styles.submit}>{busy ? "Setting up…" : "Create host account"}<ArrowRight size={16} aria-hidden="true" /></Button>
        </form>
      )}
    </AccessShell>
  );
}
