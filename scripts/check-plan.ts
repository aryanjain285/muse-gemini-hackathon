/** Confirm a project would actually animate before a paid run. */
import { config as loadEnv } from "./load-env";
loadEnv();
import { Specs } from "../src/lib/db/repo";
import { planAnimation } from "../src/lib/services/director";
import { Projects } from "../src/lib/db/repo";
import { profileFor } from "../src/lib/core/config";

const id = process.argv[2];
const { spec } = Specs.requireActive(id);
const profile = profileFor(Projects.require(id).profile as never);
const plan = planAnimation(spec, profile.name);
const total = [...plan.values()].reduce((a, b) => a + b, 0);
console.log(`  profile ${profile.name}`);
console.log(`  would animate ${plan.size}/${spec.scenes.length}: ${JSON.stringify([...plan.entries()])}`);
console.log(`  ${total}s of video, about $${(total * 0.05).toFixed(2)}`);
