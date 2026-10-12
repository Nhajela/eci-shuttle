"use client";
/** Logged out: send to /login with the exact page (and ?w=) so Telegram "Open in admin" links survive login. */
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect } from "react";

export function LoginRedirect() {
  const qs = useSearchParams().toString();
  const href = `/login?next=${encodeURIComponent(usePathname() + (qs ? `?${qs}` : ""))}`;
  const router = useRouter();
  useEffect(() => router.replace(href), [router, href]);
  return (
    <main className="p-4">
      <a href={href} className="underline">
        Log in to continue
      </a>
    </main>
  );
}
