"use client";

/**
 * Where the navigation rail applies, and where it does not.
 *
 * The landing page is a poster: a full-bleed hero, the featured film, and one way in. A fixed
 * rail down its left edge turns that into an application window and takes 15rem off the width
 * the hero was composed for. So the rail starts once you are inside.
 *
 * The decision lives here rather than in the layout because the layout is a server component
 * and cannot read the current path. Keeping the padding in the same place as the rail is the
 * point: they are one decision, and splitting them is how a page ends up indented with nothing
 * beside it.
 */
import { usePathname } from "next/navigation";
import Sidebar from "@/components/nav/Sidebar";

/** Routes that stand on their own. */
const BARE = new Set(["/"]);

export default function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname() ?? "/";
  if (BARE.has(pathname)) return <div className="relative z-10">{children}</div>;

  return (
    <>
      <Sidebar />
      <div className="relative z-10 md:pl-[15.5rem]">{children}</div>
    </>
  );
}
