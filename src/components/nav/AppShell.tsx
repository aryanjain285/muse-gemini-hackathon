"use client";

/**
 * Where the navigation rail applies, how wide it is, and what that leaves for the page.
 *
 * The landing page is a poster: full-bleed hero, featured film, one way in. A fixed rail down its
 * left edge turns that into an application window and takes 15rem off the width the hero was
 * composed for. So the rail starts once you are inside.
 *
 * And it collapses, because one page needs the room. The studio lays out a timeline and a
 * 460-pixel inspector side by side at the widest measure in the design; giving a quarter of a
 * laptop screen to navigation squeezed that grid until it broke. It now opens collapsed there and
 * expanded everywhere else, and either way the choice is remembered.
 *
 * The width and the page's indent are decided in the same component on purpose. They are one
 * decision, and splitting them is how a page ends up indented with nothing beside it.
 */
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import Sidebar from "@/components/nav/Sidebar";

/** Routes that stand on their own. */
const BARE = new Set(["/"]);

/** Routes that need the room more than they need the labels. */
const PREFERS_COLLAPSED = ["/studio"];

const STORAGE_KEY = "muse.sidebar.collapsed";

export default function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname() ?? "/";
  const tight = PREFERS_COLLAPSED.some((p) => pathname.startsWith(p));
  const [collapsed, setCollapsed] = useState(tight);

  // Read the remembered choice after mount, so the server and the first client render agree and
  // React does not complain about a mismatch it cannot see coming.
  useEffect(() => {
    const saved = window.localStorage.getItem(STORAGE_KEY);
    if (saved === "1") setCollapsed(true);
    else if (saved === "0") setCollapsed(false);
    else setCollapsed(tight);
  }, [tight]);

  const toggle = () => {
    setCollapsed((was) => {
      const next = !was;
      window.localStorage.setItem(STORAGE_KEY, next ? "1" : "0");
      return next;
    });
  };

  if (BARE.has(pathname)) return <div className="relative z-10">{children}</div>;

  return (
    <>
      <Sidebar collapsed={collapsed} onToggle={toggle} />
      <div
        className={`relative z-10 transition-[padding] duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] ${
          collapsed ? "md:pl-[4.5rem]" : "md:pl-[15.5rem]"
        }`}
      >
        {children}
      </div>
    </>
  );
}
