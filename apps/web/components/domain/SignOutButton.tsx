"use client";

import { api } from "../../lib/api-client.ts";

export function SignOutButton() {
  const handleSignOut = async () => {
    await api.signOut();
    if (typeof window !== "undefined") {
      window.location.assign("/sign-in");
    }
  };

  return (
    <button
      className="btn btn-small border border-line bg-raised hover:bg-line text-bone font-mono text-[10px] uppercase tracking-[0.14em]"
      onClick={handleSignOut}
      type="button"
    >
      Sign out
    </button>
  );
}
