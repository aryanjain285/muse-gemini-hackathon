/**
 * Apple touch icon. Generated rather than shipped as a file because Apple requires
 * a raster format here, and rendering it from the same geometry as the SVG mark
 * keeps the two from drifting apart.
 */
import { ImageResponse } from "next/og";

export const runtime = "nodejs";
export const size = { width: 180, height: 180 };
export const contentType = "image/png";

const PAPER = "#F4EFE7";
const EMBER = "#E8A44C";

export default function AppleIcon() {
  // Same bar grid as the SVG mark, scaled to the 180px touch icon.
  const bars = [
    { left: 42, top: 100, height: 30, opacity: 0.55 },
    { left: 60, top: 82, height: 48, opacity: 0.75 },
    { left: 96, top: 96, height: 34, opacity: 0.65 },
  ];
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          background: "#08080A",
          display: "flex",
          position: "relative",
        }}
      >
        {/* the 9:16 aperture */}
        <div
          style={{
            position: "absolute",
            left: 48,
            top: 18,
            width: 84,
            height: 145,
            border: `9px solid ${PAPER}`,
            borderRadius: 18,
            opacity: 0.9,
            display: "flex",
          }}
        />
        {bars.map((b) => (
          <div
            key={b.left}
            style={{
              position: "absolute",
              left: b.left,
              top: b.top,
              width: 11,
              height: b.height,
              borderRadius: 6,
              background: PAPER,
              opacity: b.opacity,
              display: "flex",
            }}
          />
        ))}
        {/* the drop */}
        <div
          style={{
            position: "absolute",
            left: 78,
            top: 46,
            width: 11,
            height: 84,
            borderRadius: 6,
            background: EMBER,
            display: "flex",
          }}
        />
      </div>
    ),
    size,
  );
}
