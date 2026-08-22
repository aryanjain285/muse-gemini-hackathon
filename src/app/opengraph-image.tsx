/**
 * Social preview card, rendered at request time.
 *
 * Built from the same tokens as the interface so a shared link looks like the
 * product rather than like a generic screenshot. No custom font is loaded: the
 * card is composed so it reads well in the default stack, which keeps it working
 * offline and removes a network dependency from a route that must never fail.
 */
import { ImageResponse } from "next/og";

export const runtime = "nodejs";
export const alt = "MUSE — AI Music Video Director";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const INK = "#08080A";
const INK_RAISED = "#0D0D11";
const PAPER = "#F4EFE7";
const PAPER_DIM = "#8A8578";
const EMBER = "#E8A44C";
const HAIRLINE = "rgba(244,239,231,0.10)";

/** The mark, inlined as elements because ImageResponse cannot load an SVG file. */
function Mark({ scale = 1 }: { scale?: number }) {
  // Bar geometry on the same grid as the SVG mark: left offset, top offset,
  // height, opacity. The third bar is the drop and is the only accent.
  const bars: { left: number; top: number; height: number; opacity: number; accent?: boolean }[] = [
    { left: 18, top: 96, height: 44, opacity: 0.55 },
    { left: 37, top: 76, height: 64, opacity: 0.75 },
    { left: 56, top: 34, height: 106, opacity: 1, accent: true },
    { left: 75, top: 88, height: 52, opacity: 0.65 },
  ];
  const w = 92 * scale;
  const h = 164 * scale;
  return (
    <div style={{ position: "relative", width: w, height: h, display: "flex" }}>
      {/* Explicit box rather than inset:0 — the OG renderer is not a browser and
          does not resolve shorthand insets, which silently drops the frame. */}
      <div
        style={{
          position: "absolute",
          left: 0,
          top: 0,
          width: w,
          height: h,
          border: `${3 * scale}px solid ${PAPER}`,
          borderRadius: 16 * scale,
          opacity: 0.9,
          display: "flex",
          boxSizing: "border-box",
        }}
      />
      {bars.map((b) => (
        <div
          key={b.left}
          style={{
            position: "absolute",
            left: b.left * scale,
            top: b.top * scale,
            width: 11 * scale,
            height: b.height * scale,
            borderRadius: 6 * scale,
            background: b.accent ? EMBER : PAPER,
            opacity: b.opacity,
          }}
        />
      ))}
    </div>
  );
}

export default async function Image() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          background: INK,
          padding: "64px 72px",
          position: "relative",
        }}
      >
        {/* A single warm glow, matching the ambient layer in the app. */}
        <div
          style={{
            position: "absolute",
            right: -160,
            top: -160,
            width: 720,
            height: 720,
            borderRadius: 720,
            background: `radial-gradient(circle, rgba(232,164,76,0.16) 0%, rgba(232,164,76,0) 68%)`,
          }}
        />

        <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
          <div style={{ position: "relative", width: 22, height: 39, display: "flex" }}>
            <div
              style={{
                position: "absolute",
                left: 0,
                top: 0,
                width: 22,
                height: 39,
                border: `2px solid ${PAPER}`,
                borderRadius: 5,
                opacity: 0.85,
                display: "flex",
                boxSizing: "border-box",
              }}
            />
            <div
              style={{
                position: "absolute",
                left: 9,
                top: 10,
                width: 3,
                height: 20,
                borderRadius: 2,
                background: EMBER,
                display: "flex",
              }}
            />
          </div>
          <div
            style={{
              fontSize: 22,
              letterSpacing: 10,
              color: PAPER,
              fontWeight: 600,
              display: "flex",
            }}
          >
            MUSE
          </div>
          <div style={{ flex: 1, height: 1, background: HAIRLINE, display: "flex" }} />
          <div style={{ fontSize: 17, color: PAPER_DIM, letterSpacing: 1, display: "flex" }}>
            AI Music Video Director
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "flex-end", gap: 56 }}>
          <div style={{ display: "flex", flexDirection: "column", flex: 1 }}>
            <div
              style={{
                fontSize: 86,
                lineHeight: 1.0,
                color: PAPER,
                letterSpacing: -3,
                display: "flex",
                flexDirection: "column",
              }}
            >
              <span>Nobody remembers</span>
              <span>
                in <span style={{ color: EMBER }}>stills</span>.
              </span>
            </div>
            <div
              style={{
                marginTop: 30,
                fontSize: 23,
                lineHeight: 1.5,
                color: PAPER_DIM,
                maxWidth: 720,
                display: "flex",
              }}
            >
              Gemini writes one timeline for story, music and picture. A deterministic editor
              lands every cut on the beat.
            </div>
          </div>

          <Mark scale={1.35} />
        </div>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 20,
            borderTop: `1px solid ${HAIRLINE}`,
            paddingTop: 24,
            fontSize: 17,
            color: PAPER_DIM,
            letterSpacing: 1,
          }}
        >
          <span style={{ display: "flex" }}>9:16 · 1080×1920 · 30s</span>
          <span style={{ display: "flex", color: "rgba(244,239,231,0.22)" }}>|</span>
          <span style={{ display: "flex" }}>DirectorSpec → parallel generation → critic → composer</span>
          <div style={{ flex: 1, display: "flex" }} />
          <span style={{ display: "flex", color: EMBER }}>Build with Gemini</span>
        </div>
      </div>
    ),
    size,
  );
}
