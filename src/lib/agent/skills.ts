/**
 * Skill documents for the director agent.
 *
 * Skills are the craft knowledge the agent needs but which does not belong in a
 * tool: how to pace a thirty second reel, what makes a drop land, when to spend a
 * video generation and when deterministic camera work is the better answer. They
 * are kept as prose because that is what a language model reads best, and they are
 * versioned so a change to the agent's judgement is a reviewable diff rather than
 * a hidden prompt edit.
 *
 * They are embedded as string constants rather than read from disk so the bundler
 * never has to treat them as runtime assets and a deployed build cannot lose them.
 */

export interface Skill {
  name: string;
  /** One line the agent sees in its index, to decide whether to read the whole thing. */
  summary: string;
  version: number;
  body: string;
}

const DIRECTING: Skill = {
  name: "directing",
  summary: "How to structure a 30 second vertical reel so it reads as a film, not a montage.",
  version: 2,
  body: `# Directing a thirty second reel

A thirty second vertical reel has room for one idea, told in five to seven shots.
Trying to tell two stories produces neither.

## Shape
Open on recognition. The first shot must contain something the viewer already
knows — the actual person, the actual place — because recognition buys attention
that novelty cannot. Then open the world, then introduce motion, then build, then
land the drop, then vary it once, then resolve.

The drop belongs around the halfway mark, near fifteen seconds. Earlier and the
build has not earned it; later and there is no room to enjoy it.

## One purpose per shot
Every scene does exactly one visual thing. A shot that both introduces a character
and transforms the environment and changes the palette will do all three badly.
If a scene's description contains "and then", it is two scenes.

## Cover it
Vary how far the camera sits. Seven shots taken from the same distance read as one
long shot no matter how the content changes, and that is the most common way a reel
comes out looking generated rather than directed.

Choose a shot size per scene and let it change: a close shot to meet somebody, a wide
to say where we are, a full to show a whole figure against it, an insert on one object
with nobody in it. Never three shots running at the same size. Always at least one
close enough to read an expression and one wide enough to place the film.

Committing to a size also improves what a shot is *of*. Asked for a wide, you look for
the car on the cliff road; asked for an insert, you find the folded map on the
dashboard. Content follows framing.

## Continuity beats novelty
A viewer forgives a repeated setting. A viewer does not forgive a face that changes
between shots. Identity is harder to hold the closer the camera gets, so a close shot
needs the subject reference carried into its prompt — but that is a reason to attach
the reference, not a reason to shoot everything from a distance.

Carry the same wardrobe, the same palette words and the same lighting sentence
through every scene prompt. Sameness of language produces sameness of image.

## Pacing
Early shots can breathe for three to four seconds. Around the build, cut faster —
one and a half to two seconds — because acceleration is what makes a drop feel
inevitable. After the drop, slow down again. The final shot should hold long
enough to read a title.

## The last second
Always end on a held frame with a title, landing on the final musical hit. A reel
that simply stops feels like a file that ran out. A reel that lands feels edited.`,
};

const MUSIC: Skill = {
  name: "music",
  summary: "How to brief a score and why requested timestamps are intent, not instruction.",
  version: 1,
  body: `# Briefing a score

## Ask for structure, not adjectives
"Dreamy and emotional" gives a model nothing to build. "118 BPM, A minor, sparse
warm pad for the first four seconds, percussion enters at 3.5, density rises from
11 to 15, strongest energy at 15, resolve after 25, clean tail by 30" gives it a
shape. Always state instrumental only and no vocals, or you will get mumbling.

## Timestamps are intent
A generative music model treats requested times as a description of the kind of
track you want, not as a click track it must obey. Asking for a drop at fifteen
seconds makes a track that has a drop somewhere near the middle. It does not
guarantee a transient at 15.000.

This is why the returned audio is always analysed and the real accents are matched
against the plan. Never assume the requested time is the real time. Never move
the picture to where you hoped the music would be.

## What makes a drop land
Contrast, not volume. The half second before a drop should be emptier than
everything around it — drop the drums, drop the bass, leave a riser and air. The
drop itself then needs no extra loudness to feel enormous.

## When the score is wrong
A missing drop is worth exactly one regeneration. Everything else — a weak accent,
a soft transition, an unclear section — is cheaper and more reliable to fix at mix
time with a deterministic impact or riser than by generating again and hoping.`,
};

const VISUAL: Skill = {
  name: "visual",
  summary: "Prompting for identity-stable keyframes, and when generated motion is worth it.",
  version: 1,
  body: `# Making the pictures

## Prompt order matters
Medium, then subject with immutable traits, then action, then setting, then shot
size and placement in the vertical frame, then lighting, then palette, then the
negative constraints. Front-loading the medium ("loose gouache painting with
visible brush texture") is what stops the model drifting toward photography.

Never ask for text in an image. Text is drawn by the composer, where it is crisp,
correctly kerned, and spelled.

## Vertical framing is a constraint, not a crop
State it explicitly: subject in the lower two thirds, generous headroom above.
Models compose for square by default, and a square composition cropped to 9:16
loses either the face or the context.

## Identity
Pass the same subject reference image every time. Repeat the immutable traits as
literal words in every prompt. When a face drifts, do not re-animate the drifted
frame — regenerate the keyframe, because animating a wrong face just produces a
moving wrong face.

## When to spend a video generation
Generated motion is the most expensive and least predictable thing available.
Spend it on the drop, where transformation is the point, and where a viewer is
looking at the whole frame rather than at a face.

Everywhere else, deterministic camera work over a strong still — a slow push, a
parallax drift, a whip into the next shot — reads as more intentional than
generated motion, not less. A slow push on a beautiful painting is cinema. Four
seconds of a model guessing what happens next is a lottery.

## Judging a shot
Look for the failure modes that actually ruin reels: a face that changed, a limb
that duplicated, a subject cropped out of the vertical safe region, a clip that
does not move, a frame that decodes black. Everything else is taste, and taste is
not worth a retry.`,
};

const EDITING: Skill = {
  name: "editing",
  summary: "Why cuts land on measured accents, and how transitions are chosen.",
  version: 1,
  body: `# Cutting to the music

## Code owns the timeline
Models propose; the composer decides exactly where a cut happens. Every cut is
placed on an accent that was measured in the actual waveform, not on the time the
plan hoped for. A cut two hundred milliseconds off the beat reads as sloppy even
to a viewer who could not name what is wrong.

## Transitions are chosen from a short list
Nine primitives, applied by code: cut, crossfade, dip to black, dip to white,
flash, whip pan, luma wipe, film burn, match cut. A hard cut is the default and
usually the right answer. Reach for a transition when it does work a cut cannot:
a flash to hide a jump on the drop, a whip to connect two unrelated spaces, a dip
to black to mark the end of a section.

Never leave the transition to generated video. A model asked to "transition into
the next scene" produces a smear.

## The transition arithmetic
A cross-dissolve overlaps two clips, so it shortens the reel. Every clip is
therefore rendered slightly longer than its scene window — by exactly the length
of its incoming transition — so that after the overlap the timeline still lands on
the planned duration. Getting this wrong slides every subsequent cut off the beat.

## Grade once
Colour, grain and vignette go on the joined timeline, not on individual clips. A
reel graded shot by shot looks like seven different films.`,
};

const OPERATING: Skill = {
  name: "operating",
  summary: "Budget discipline, fallbacks, deadlines, and what never to cut.",
  version: 1,
  body: `# Operating the system

## Spend deliberately
Every generation costs real money against a hard ceiling. Before spending, ask
whether a deterministic answer would be as good — for most scenes it is. The
budget exists so the demo can be run repeatedly; burning it on one perfect take is
a bad trade.

Re-running an identical request is free, because responses are cached by request
hash. Changing a prompt is not free. Think before you re-prompt.

## Everything has a fallback
No model failure may prevent an export. An image model that fails yields a
stylised photograph or a procedurally composed frame. A video model that fails
yields deterministic camera motion. A music model that fails yields a synthesised
score. A transition chain that fails yields hard cuts. This is not degradation for
its own sake — it is what makes the system demonstrable.

## Respect the deadline
Past the deadline, stop starting new work and compose with what exists. A reel
that lands is worth more than a scene that is still improving.

## What never gets cut
The shared timeline, the deterministic composition, and the storyboard. Those are
the product. Live voice direction, multiple presets, a second subject, generated
music, even the automated critic — all of those can go before any of the three.`,
};

export const SKILLS: Skill[] = [DIRECTING, MUSIC, VISUAL, EDITING, OPERATING];

const BY_NAME = new Map(SKILLS.map((s) => [s.name, s]));

export function getSkill(name: string): Skill | undefined {
  return BY_NAME.get(name.trim().toLowerCase());
}

export function skillNames(): string[] {
  return SKILLS.map((s) => s.name);
}

/** The index the agent sees up front, so it can pull only what it needs. */
export function skillIndex(): string {
  return SKILLS.map((s) => `- ${s.name}: ${s.summary}`).join("\n");
}

/**
 * The skills always loaded into the system instruction. Directing and operating
 * shape every decision, so paying for their tokens on every turn is worth it;
 * the rest are fetched on demand via the read_skill tool.
 */
export function coreSkills(): string {
  return [DIRECTING, OPERATING].map((s) => s.body).join("\n\n---\n\n");
}

/** Version string for cache keys, so editing a skill retires stale agent runs. */
export function skillsVersion(): string {
  return SKILLS.map((s) => `${s.name}${s.version}`).join(".");
}
