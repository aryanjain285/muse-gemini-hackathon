/**
 * Reference images have to arrive at the model named.
 *
 * `buildContinuity` labels every reference it assembles, and the label was then dropped on
 * the way out — the request carried a pile of anonymous pictures and a prompt that talked
 * about "the group" and "the protagonist" as though the model could tell which was which.
 * It could not, so it matched the first face and invented the others.
 *
 * The label is computed a long way from the request that sends it, which is exactly the kind
 * of gap nothing else would catch: both halves look correct on their own.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const generateContent = vi.fn();

vi.mock("@/lib/models/gemini", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/models/gemini")>()),
  generateContent: (...args: unknown[]) => generateContent(...args),
}));

const { generateImage } = await import("@/lib/models/adapters");

/** One returned image, which is all the adapter needs to reach its happy path. */
function reply() {
  return {
    candidates: [
      {
        content: {
          parts: [{ inlineData: { mimeType: "image/png", data: Buffer.from("png").toString("base64") } }],
        },
      },
    ],
    modelVersion: "test",
  };
}

interface TextPart {
  text?: string;
  inlineData?: { mimeType: string; data: string };
}

function partsSent(): TextPart[] {
  const body = generateContent.mock.calls[0][1] as { contents: { parts: TextPart[] }[] };
  return body.contents[0].parts;
}

describe("sending reference images", () => {
  beforeEach(() => {
    generateContent.mockReset();
    generateContent.mockResolvedValue(reply());
  });

  it("names each reference in the text immediately before its image", async () => {
    await generateImage({
      model: "test-image",
      prompt: "the prompt",
      references: [
        { bytes: Buffer.from("group"), mime: "image/jpeg", label: "the 3 people in this scene" },
        { bytes: Buffer.from("solo"), mime: "image/jpeg", label: "the protagonist" },
      ],
    });

    const parts = partsSent();
    // Text, image, text, image, prompt — in that order, so each name attaches to the picture
    // that follows it rather than to whichever one the model guesses.
    expect(parts).toHaveLength(5);
    expect(parts[0].text).toContain("the 3 people in this scene");
    expect(parts[1].inlineData?.data).toBe(Buffer.from("group").toString("base64"));
    expect(parts[2].text).toContain("the protagonist");
    expect(parts[3].inlineData?.data).toBe(Buffer.from("solo").toString("base64"));
    expect(parts[4].text).toBe("the prompt");
  });

  it("sends an unlabelled reference as it always did", async () => {
    await generateImage({
      model: "test-image",
      prompt: "the prompt",
      references: [{ bytes: Buffer.from("x"), mime: "image/jpeg" }],
    });
    const parts = partsSent();
    expect(parts).toHaveLength(2);
    expect(parts[0].inlineData).toBeTruthy();
  });
});
