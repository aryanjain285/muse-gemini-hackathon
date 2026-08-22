import type { Metadata, Viewport } from "next";
import "./globals.css";
import { AmbientGlow, GrainOverlay } from "@/components/ui/grain";
import AppShell from "@/components/nav/AppShell";

const DESCRIPTION =
  "MUSE directs your own photographs into a film — it casts the faces, writes the story, composes the score, and lands every cut on the beat.";

export const metadata: Metadata = {
  // Resolves the relative social-image URLs. MUSE runs locally by default, so the
  // port it actually serves on is the sensible base; override with MUSE_SITE_URL
  // when it is hosted somewhere.
  metadataBase: new URL(process.env.MUSE_SITE_URL ?? "http://localhost:3939"),
  // A template keeps every page ending in the product name without repeating it
  // at each call site.
  title: { default: "MUSE — AI Music Video Director", template: "%s — MUSE" },
  description: DESCRIPTION,
  applicationName: "MUSE",
  authors: [{ name: "MUSE" }],
  keywords: [
    "AI music video",
    "Gemini",
    "Lyria",
    "Veo",
    "generative video",
    "vertical reel",
  ],
  openGraph: {
    title: "MUSE — AI Music Video Director",
    description: DESCRIPTION,
    siteName: "MUSE",
    type: "website",
  },
  twitter: { card: "summary_large_image", title: "MUSE", description: DESCRIPTION },
  other: {
    // Generated media is labelled in product metadata as well as on screen.
    "ai-generated": "true",
  },
};

export const viewport: Viewport = {
  themeColor: "#08080a",
  colorScheme: "dark",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body className="min-h-[100dvh] bg-ink-950 text-paper-100 antialiased">
        {/* Fixed, pointer-events-none texture layers. Kept outside the scroll
            container so they never trigger a repaint while the page moves. */}
        <AmbientGlow />
        <GrainOverlay />
        {/* One navigation for the whole product, mounted here so it survives every route
            change rather than being rebuilt by each page. The shell decides where it applies:
            the landing page is a poster and stands without it. */}
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
