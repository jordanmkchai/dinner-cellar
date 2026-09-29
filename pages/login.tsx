import React, { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ArrowRight } from "lucide-react";
import { Button } from "../components/Button";
import { Input } from "../components/Input";
import { postLogin } from "../endpoints/auth/login_with_password_POST.schema";
import { useAuth } from "../helpers/useAuth";
import AccessShell from "../components/AccessShell";
import styles from "./login.module.css";

export default function LoginPage() {
  const navigate = useNavigate();
  const { onLogin } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const result = await postLogin({ email, password });
      onLogin(result.user);
      navigate("/host-access", { replace: true });
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Sign in failed. Check your details and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <AccessShell eyebrow="HOST ACCESS" title="Welcome back." description="Sign in to manage your Dinner Cellar and its private guest access.">
      <form className={styles.form} onSubmit={(event) => void handleSubmit(event)}>
        <label className={styles.field} htmlFor="login-email"><span>Email</span><Input id="login-email" type="email" autoComplete="username" required value={email} onChange={(event) => setEmail(event.target.value)} /></label>
        <label className={styles.field} htmlFor="login-password"><span>Password</span><Input id="login-password" type="password" autoComplete="current-password" required value={password} onChange={(event) => setPassword(event.target.value)} /></label>
        {error && <p className={styles.error} role="alert">{error}</p>}
        <Button type="submit" disabled={busy || !email.trim() || !password} className={styles.submit}>{busy ? "Signing in…" : "Sign in"}<ArrowRight size={16} aria-hidden="true" /></Button>
      </form>
      <p className={styles.footnote}><Link to="/setup">First-time host setup</Link> · Use your private setup code.</p>
      <p className={styles.guestNote}>Were you invited? Open the private guest link shared by your host.</p>
      <Link to="/" className={styles.backLink}>Back to cellar home</Link>
    </AccessShell>
  );
}
