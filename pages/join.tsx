import React, { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowRight, LockKeyhole, Wine } from "lucide-react";
import { Button } from "../components/Button";
import { postExchangeGuestLink } from "../endpoints/access/guest/exchange_POST.schema";
import { clearCellarPrivateQueries } from "../helpers/useAuth";
import { resetPrivateCart } from "../helpers/cartStore";
import AccessShell from "../components/AccessShell";
import styles from "./join.module.css";

type JoinState = "checking" | "missing" | "failed";

export default function JoinPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const attempted = useRef(false);
  const [state, setState] = useState<JoinState>("checking");

  useEffect(() => {
    if (attempted.current) return;
    attempted.current = true;
    const cleanUrl = `${window.location.pathname}${window.location.search}`;
    const token = new URLSearchParams(window.location.hash.replace(/^#/, "")).get("token");
    window.history.replaceState(window.history.state, "", cleanUrl);
    if (!token) {
      setState("missing");
      return;
    }

    void postExchangeGuestLink({ token }).then(() => {
      resetPrivateCart();
      clearCellarPrivateQueries(queryClient);
      navigate("/", { replace: true });
    }).catch(() => {
      setState("failed");
    });
  }, [navigate, queryClient]);

  return (
    <AccessShell eyebrow="GUEST ACCESS" title={state === "checking" ? "Opening your invitation." : "This invitation needs attention."} description={state === "checking" ? "Verifying your private link before opening the cellar." : "Ask your host for a fresh private guest link, then open it here."}>
      {state === "checking" ? <div className={styles.loading}><span><Wine size={20} aria-hidden="true" /></span><p>Checking invitation…</p><div className={styles.progress} /></div> : (
        <div className={styles.expired}>
          <LockKeyhole size={19} aria-hidden="true" />
          <p>{state === "missing" ? "No guest token was found in this link." : "This guest link is invalid or has been closed by the host."}</p>
          <Button asChild variant="outline"><Link to="/">Return home <ArrowRight size={15} aria-hidden="true" /></Link></Button>
        </div>
      )}
    </AccessShell>
  );
}
