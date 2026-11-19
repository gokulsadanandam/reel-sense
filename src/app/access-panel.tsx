"use client";

import { useEffect, useRef, useState } from "react";

// Lets the visitor choose who pays for their questions:
//   free  - the site's free-tier models (may be busy)
//   byok  - their own Replicate token (kept in this browser only)
//   owner - an access code (for the site owner; option shown only via /#owner)

export type AccessMode = "free" | "byok" | "owner";
type Available = Record<AccessMode, boolean>;

export interface AccessSettings {
  mode: AccessMode;
  token: string;
  code: string;
}

const STORAGE_KEY = "reelsense.access";
const EMPTY: AccessSettings = { mode: "free", token: "", code: "" };

export const MODE_LABEL: Record<AccessMode, string> = {
  free: "free tier",
  byok: "your Replicate token",
  owner: "access code",
};

/** Headers that tell /api/ask which mode to use. Credentials go only to our own API. */
export function accessHeaders(s: AccessSettings): Record<string, string> {
  const h: Record<string, string> = { "x-reelsense-mode": s.mode };
  if (s.mode === "byok" && s.token) h["x-replicate-token"] = s.token.trim();
  if (s.mode === "owner" && s.code) h["x-access-code"] = s.code;
  return h;
}

function load(): AccessSettings {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null") as Partial<AccessSettings> | null;
    return { ...EMPTY, ...saved };
  } catch {
    return EMPTY;
  }
}

function save(s: AccessSettings) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {
    // Private mode / blocked storage: settings just last for this visit.
  }
}

export function useAccess() {
  const [settings, setSettings] = useState<AccessSettings>(EMPTY);
  const [available, setAvailable] = useState<Available | null>(null);

  useEffect(() => {
    const saved = load();
    setSettings(saved);
    fetch("/api/access")
      .then((r) => r.json() as Promise<Available>)
      .then((a) => {
        setAvailable(a);
        // Fall back if the saved mode isn't offered here (e.g. free tier not configured).
        if (!a[saved.mode]) setSettings((s) => ({ ...s, mode: a.free ? "free" : "byok" }));
      })
      .catch(() => setAvailable({ free: false, byok: true, owner: false }));
  }, []);

  function update(patch: Partial<AccessSettings>) {
    setSettings((prev) => {
      const next = { ...prev, ...patch };
      save(next);
      return next;
    });
  }

  return { settings, available, update };
}

const MODE_NAME: Record<AccessMode, string> = {
  free: "Free tier",
  byok: "My Replicate token",
  owner: "Access code",
};

const MODE_HINT: Record<AccessMode, string> = {
  free: "Shared free models. No sign-up, may be busy at times.",
  byok: "Your own Replicate account, about $0.01 per question.",
  owner: "For the site owner.",
};

/** True when the chosen mode has what it needs to send a question. */
export function isReady(s: AccessSettings): boolean {
  return s.mode === "free" || (s.mode === "byok" ? s.token.trim() !== "" : s.code !== "");
}

/**
 * Compact provider button for the chat bar. Clicking it opens a panel above the bar
 * where the visitor picks a provider and enters its token or code.
 */
export function AccessPicker({
  settings,
  available,
  update,
  open,
  setOpen,
}: ReturnType<typeof useAccess> & { open: boolean; setOpen: (open: boolean) => void }) {
  const [showOwner, setShowOwner] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const fieldRef = useRef<HTMLInputElement>(null);

  useEffect(() => setShowOwner(window.location.hash === "#owner" || settings.mode === "owner"), [settings.mode]);

  // Close on outside click or Escape.
  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, setOpen]);

  // Jump straight to the token / code field when the chosen mode needs one.
  useEffect(() => {
    if (open && settings.mode !== "free") fieldRef.current?.focus();
  }, [open, settings.mode]);

  if (!available) return null;
  const modes = (["free", "byok", "owner"] as const).filter((m) => available[m] && (m !== "owner" || showOwner));
  const ready = isReady(settings);

  return (
    <div className="picker" ref={rootRef}>
      <button
        type="button"
        className={`picker-button${ready ? "" : " needs-setup"}`}
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-haspopup="dialog"
        title="Choose who powers the answers"
      >
        <span className="picker-dot" aria-hidden="true" />
        <span className="picker-label">{MODE_NAME[settings.mode]}</span>
        <span aria-hidden="true">▴</span>
      </button>

      {open && (
        <div className="picker-panel" role="dialog" aria-label="Answers powered by">
          <p className="picker-title">Answers powered by</p>
          <div role="radiogroup" className="picker-options">
            {modes.map((m) => (
              <label key={m} className={settings.mode === m ? "selected" : ""}>
                <input type="radio" name="access" checked={settings.mode === m} onChange={() => update({ mode: m })} />
                <span>
                  <strong>{MODE_NAME[m]}</strong>
                  <small>{MODE_HINT[m]}</small>
                </span>
              </label>
            ))}
          </div>

          {settings.mode === "byok" && (
            <div className="access-field">
              <input
                ref={fieldRef}
                type="password"
                value={settings.token}
                onChange={(e) => update({ token: e.target.value })}
                placeholder="Paste your token: r8_…"
                aria-label="Your Replicate API token"
                autoComplete="off"
                spellCheck={false}
              />
              {settings.token && (
                <button type="button" onClick={() => update({ token: "" })}>
                  Forget
                </button>
              )}
              <p className="access-note">
                Kept only in this browser and sent with each question; never saved on the server.{" "}
                <a href="https://replicate.com/account/api-tokens" target="_blank" rel="noopener noreferrer">
                  Get a token
                </a>
              </p>
            </div>
          )}

          {settings.mode === "owner" && (
            <div className="access-field">
              <input
                ref={fieldRef}
                type="password"
                value={settings.code}
                onChange={(e) => update({ code: e.target.value })}
                placeholder="Access code"
                aria-label="Access code"
                autoComplete="current-password"
              />
              {settings.code && (
                <button type="button" onClick={() => update({ code: "" })}>
                  Forget
                </button>
              )}
            </div>
          )}

          <button type="button" className="picker-done" onClick={() => setOpen(false)} disabled={!ready}>
            {ready ? "Done" : settings.mode === "byok" ? "Enter a token to continue" : "Enter the code to continue"}
          </button>
        </div>
      )}
    </div>
  );
}
