"use client";

import { useState } from "react";
import { Seal } from "./seal";

export default function AdminLogin() {
  const [pw, setPw] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!pw) {
      setErr("Enter the admin password.");
      return;
    }
    setBusy(true);
    setErr("");
    const res = await fetch("/api/admin/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: pw }),
    }).catch(() => null);
    setBusy(false);
    if (res?.ok) {
      window.location.reload();
      return;
    }
    const data = await res?.json().catch(() => null);
    setErr(data?.error ?? "Couldn't reach the server. Try again.");
  }

  return (
    <main className="admin-center">
      <form className="login-card" onSubmit={submit}>
        <Seal size={40} />
        <h1 className="read">Document admin</h1>
        <p>Sign in to upload documents and run the evaluation.</p>
        <label htmlFor="pw" className="label">
          Password
        </label>
        <input
          id="pw"
          type="password"
          className="field"
          autoComplete="current-password"
          value={pw}
          onChange={(e) => {
            setPw(e.target.value);
            setErr("");
          }}
          aria-invalid={!!err}
          aria-describedby={err ? "pw-err" : undefined}
          autoFocus
        />
        {err && (
          <p id="pw-err" className="field-error" role="alert">
            {err}
          </p>
        )}
        <button className="btn btn-seal" disabled={busy}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </main>
  );
}
