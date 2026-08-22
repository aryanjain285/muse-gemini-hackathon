/** Learn Veo's real duration contract before spending a run on it. */
import fs from "node:fs";
import { config as loadEnv } from "./load-env";
loadEnv();
import { generateVideo } from "@/lib/models/adapters";

const still = "workspace/assets/prj_k7b1esniqu92/keyframe-s05-v1-a0.png";
const bytes = fs.readFileSync(still);

async function attempt(seconds: number) {
  const t = Date.now();
  try {
    const out = await generateVideo({
      model: "veo-3.1-lite-generate-preview",
      prompt:
        "A young woman in an olive jacket stands on a cliff above the sea at sunset; the wind moves her hair and coat, the waves roll below, the camera drifts slowly. Painterly gouache, no text.",
      seconds,
      aspectRatio: "9:16",
      resolution: "720p",
      image: { bytes, mime: "image/png" },
      timeoutMs: 420_000,
    });
    console.log(`  ${seconds}s -> OK  ${out.value.bytes.length} bytes  ${out.value.seconds}s  (${Math.round((Date.now()-t)/1000)}s wall)`);
    fs.writeFileSync(`workspace/tmp/veo-${seconds}s.mp4`, out.value.bytes);
    return true;
  } catch (e) {
    console.log(`  ${seconds}s -> FAIL ${String((e as Error).message).slice(0, 150)}`);
    return false;
  }
}

// 5 is the value that failed in the run. If discrete durations are the rule, 5 fails
// and 6 succeeds; if the bound message was literal, both should work.
async function main() {
  await attempt(5);
  await attempt(6);
}
void main();
