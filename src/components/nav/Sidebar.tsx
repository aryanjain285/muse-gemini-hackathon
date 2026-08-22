"use client";

/**
 * The one way around the product.
 *
 * Every page had grown its own header with its own set of links — the gallery knew about Ask
 * MUSE, Ask MUSE knew about the gallery, the sketch studio knew about both, and none of them
 * agreed on shape or order. Moving between them meant re-finding the navigation each time.
 *
 * This lives in the root layout, so it is the same on every screen and does not re-mount when a
 * route changes. Below the mobile breakpoint it collapses to a bar at the top, because a fixed
 * rail on a phone costs more width than the content can spare.
 */
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { Logo } from "@/components/brand/Logo";
import { Icon, type IconName } from "@/components/ui/primitives";

interface Destination {
  href: string;
  label: string;
  icon: IconName;
  hint: string;
  /** Matches when the path starts with this, for nested routes like /studio/<id>. */
  prefix?: string;
}

// No Home entry: the wordmark above the list already goes there, and a row that repeats the
// logo directly beneath it is the one item nobody needs.
const DESTINATIONS: Destination[] = [
  { href: "/ask", label: "Ask MUSE", icon: "wand", hint: "Talk to it", prefix: "/ask" },
  {
    href: "/gallery?view=memories",
    label: "Memories",
    icon: "frame",
    hint: "Your library",
    prefix: "/gallery",
  },
  { href: "/sketch", label: "Sketch studio", icon: "scissors", hint: "Draw a memory", prefix: "/sketch" },
  { href: "/gallery?view=films", label: "Films", icon: "film", hint: "Everything made" },
];

function isActive(pathname: string, d: Destination, search: string): boolean {
  if (d.prefix) {
    if (!pathname.startsWith(d.prefix)) return false;
    // Two entries share /gallery; the query string is what separates them.
    if (d.prefix === "/gallery") return search.includes("view=memories") || search === "";
    return true;
  }
  if (d.href.startsWith("/gallery?view=films")) {
    return pathname.startsWith("/gallery") && search.includes("view=films");
  }
  return pathname === d.href;
}

export default function Sidebar({
  collapsed = false,
  onToggle,
}: {
  /** Icon-only rail, for pages that need the width more than the labels. */
  collapsed?: boolean;
  onToggle?: () => void;
}) {
  const pathname = usePathname() ?? "/";
  const [open, setOpen] = useState(false);
  // usePathname does not carry the query, and two destinations differ only by it. Reading it
  // from the browser keeps this a client concern rather than forcing the whole tree dynamic.
  const search = typeof window === "undefined" ? "" : window.location.search;

  const links = DESTINATIONS.map((d) => {
    const active = isActive(pathname, d, search);
    return (
      <li key={d.label}>
        <Link
          href={d.href}
          onClick={() => setOpen(false)}
          aria-current={active ? "page" : undefined}
          // The label is the accessible name when it is visible; when it is not, the title and
          // aria-label carry it, so a collapsed rail is still navigable by screen reader.
          title={collapsed ? `${d.label} — ${d.hint}` : undefined}
          aria-label={collapsed ? d.label : undefined}
          className={`group flex items-center rounded-core py-2.5 transition-colors duration-200 ${
            collapsed ? "justify-center px-2" : "gap-3 px-3"
          } ${
            active
              ? "bg-ink-850 text-paper-50"
              : "text-paper-400 hover:bg-ink-900 hover:text-paper-100"
          }`}
        >
          <span
            className={`grid size-7 shrink-0 place-items-center rounded-core-sm border transition-colors duration-200 ${
              active
                ? "border-hairline-ember bg-ember-500/12 text-ember-200"
                : "border-hairline bg-ink-950 text-paper-500 group-hover:text-paper-300"
            }`}
          >
            <Icon name={d.icon} size={13} />
          </span>
          {collapsed ? null : (
            <span className="min-w-0">
              <span className="block truncate font-sans text-[13px] leading-tight">{d.label}</span>
              <span className="block truncate font-mono text-[10px] leading-tight text-paper-600">
                {d.hint}
              </span>
            </span>
          )}
        </Link>
      </li>
    );
  });

  return (
    <>
      {/* ── phone: a bar, and a sheet when opened ─────────────────────────────── */}
      <div className="sticky top-0 z-40 flex items-center justify-between gap-3 border-b border-hairline bg-ink-950/90 px-4 py-3 backdrop-blur md:hidden">
        <Link href="/" aria-label="MUSE home" className="text-paper-200">
          <Logo size={18} wordSize={11} />
        </Link>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-label={open ? "Close navigation" : "Open navigation"}
          className="rounded-core border border-hairline px-3 py-1.5 font-mono text-[11px] text-paper-300"
        >
          {open ? "Close" : "Menu"}
        </button>
      </div>
      {open ? (
        <nav className="sticky top-[57px] z-30 border-b border-hairline bg-ink-1000/95 px-3 py-3 backdrop-blur md:hidden">
          <ul className="flex list-none flex-col gap-1">{links}</ul>
        </nav>
      ) : null}

      {/* ── desktop: a fixed rail ─────────────────────────────────────────────── */}
      <nav
        aria-label="Main"
        className={`fixed left-0 top-0 z-40 hidden h-[100dvh] flex-col border-r border-hairline bg-ink-1000/70 py-6 backdrop-blur transition-[width] duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] md:flex ${
          collapsed ? "w-[4.5rem] px-2" : "w-[15.5rem] px-4"
        }`}
      >
        <Link
          href="/"
          aria-label="MUSE home"
          className={`mb-8 block text-paper-200 transition-colors hover:text-paper-50 ${
            collapsed ? "self-center" : "px-2"
          }`}
        >
          <Logo size={22} wordSize={13} markOnly={collapsed} />
        </Link>

        <ul className="flex list-none flex-col gap-1">{links}</ul>

        <button
          type="button"
          onClick={onToggle}
          aria-label={collapsed ? "Expand the navigation" : "Collapse the navigation"}
          title={collapsed ? "Expand" : "Collapse"}
          className={`mt-auto flex items-center rounded-core py-2 text-paper-500 transition-colors duration-200 hover:bg-ink-900 hover:text-paper-200 ${
            collapsed ? "justify-center px-2" : "gap-2 px-3"
          }`}
        >
          <span
            className={`inline-block transition-transform duration-300 ${collapsed ? "" : "rotate-180"}`}
          >
            <Icon name="chevron" size={13} />
          </span>
          {collapsed ? null : <span className="font-mono text-[10px]">Collapse</span>}
        </button>

        {collapsed ? null : (
          <p className="mt-3 px-3 font-mono text-[10px] leading-relaxed text-paper-700">
            Nobody remembers in stills.
          </p>
        )}
      </nav>
    </>
  );
}
