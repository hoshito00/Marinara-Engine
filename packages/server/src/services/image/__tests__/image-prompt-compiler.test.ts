import test from "node:test";
import assert from "node:assert/strict";
import { createDefaultImageStyleProfileSettings } from "../../../../../shared/src/constants/image-style-profiles.js";
import { compileImagePrompt } from "../../../../../shared/src/utils/image-prompt-compiler.js";

test("compileImagePrompt dedupes tags and moves simple negative fragments", () => {
  const settings = createDefaultImageStyleProfileSettings();
  const compiled = compileImagePrompt({
    kind: "portrait",
    prompt:
      "Create a portrait of Mira, anime style, best quality, high quality, detailed eyes. Avoid blurry, text, watermark. no extra fingers",
    styleProfiles: settings,
    styleProfileId: "danbooru",
  });

  assert.match(compiled.prompt, /detailed eyes/);
  assert.doesNotMatch(compiled.prompt, /\bMira\b/);
  assert.doesNotMatch(compiled.prompt, /\btext\b/);
  assert.doesNotMatch(compiled.prompt, /\bwatermark\b/);
  assert.doesNotMatch(compiled.prompt, /\bAvoid\b/i);
  assert.match(compiled.negativePrompt, /extra fingers/);
  assert.match(compiled.negativePrompt, /text/);
  assert.ok(compiled.diagnostics.removedPositiveDuplicates.length > 0);
  assert.ok(compiled.diagnostics.movedNegativeFragments.length > 0);
});

test("compileImagePrompt preserves Z-Image Turbo narrative phrasing", () => {
  const settings = createDefaultImageStyleProfileSettings();
  const compiled = compileImagePrompt({
    kind: "illustration",
    prompt: "A moonlit courtyard where Mira reaches for a glowing door, no watermark",
    styleProfiles: settings,
    styleProfileId: "z-image-turbo",
  });

  assert.equal(compiled.profile.id, "z-image-turbo");
  assert.match(compiled.prompt, /moonlit courtyard/);
  assert.match(compiled.prompt, /glowing door/);
  assert.match(compiled.negativePrompt, /watermark/);
});

test("compileImagePrompt distills verbose avatar source prompts when tag grammar is selected", () => {
  const settings = createDefaultImageStyleProfileSettings();
  const compiled = compileImagePrompt({
    kind: "avatar",
    prompt: [
      "Create a polished character avatar portrait for Cricket.",
      "Canonical appearance: Cricket.",
      "Type: Main character.",
      "Species: Human.",
      "Appearance: Short brown hair, grey eyes.",
      "Personality: Optimistic, scatterbrained, dramatic.",
      "Traits: Exceptionally unlucky, clumsy, total idiot.",
      "Occupation: Owner (and sole employee) of the Triple A Adventuring Agency.",
      "Skills: Cooking, peeling potatoes, lifting heavy boxes. No actual talents.",
      "Equipment: Leather armor, shortsword.",
      "Goal: To create the most successful adventuring agency in all of Sharn!",
      "No matter how hard she tries she can't seem to catch a break.",
      "Background: Cricket was born in Eston, Cyre and moved to Sharn as a refugee after the Mourning.",
      "She joined the army and hoped she would be better with a sword than spells.",
      "The debt collectors let her know in no uncertain terms that they want their money.",
      "She is still determined to build her agency.",
      "Composition: centered face-and-shoulders portrait, readable expression, clear silhouette, suitable as a chat avatar.",
    ].join(" "),
    styleProfiles: settings,
    styleProfileId: "photorealistic",
    imageDefaults: {
      version: 1,
      service: "automatic1111",
      seed: -1,
      automatic1111: {
        promptPrefix: "<lora:dmd:1>",
        negativePromptPrefix: "",
        sampler: "Euler a",
        scheduler: "",
        steps: 20,
        cfgScale: 7,
        clipSkip: null,
        restoreFaces: false,
        denoisingStrength: 0.6,
      },
    },
  });

  assert.match(compiled.prompt, /<lora:dmd:1>/);
  assert.match(compiled.prompt, /Short brown hair/);
  assert.match(compiled.prompt, /female/);
  assert.match(compiled.prompt, /grey eyes/);
  assert.match(compiled.prompt, /Leather armor/);
  assert.match(compiled.prompt, /young adult/);
  assert.ok(compiled.prompt.length <= 140, compiled.prompt);
  assert.equal(compiled.prompt.split(", ")[0], "<lora:dmd:1>", compiled.prompt);
  assert.ok(compiled.prompt.indexOf("female") < compiled.prompt.indexOf("Short brown hair"), compiled.prompt);
  assert.doesNotMatch(compiled.prompt, /Cricket,/);
  assert.doesNotMatch(compiled.prompt, /Photorealistic SDXL image/);
  assert.doesNotMatch(compiled.prompt, /Background:/);
  assert.doesNotMatch(compiled.prompt, /Personality:/);
  assert.doesNotMatch(compiled.prompt, /Goal:/);
  assert.doesNotMatch(compiled.prompt, /refugee/);
  assert.doesNotMatch(compiled.prompt, /hoped/);
  assert.doesNotMatch(compiled.prompt, /spells/);
  assert.doesNotMatch(compiled.prompt, /uncertain/);
  assert.doesNotMatch(compiled.prompt, /agency/);
  assert.doesNotMatch(compiled.prompt, /\.\s+[A-Z]/);
  assert.doesNotMatch(compiled.negativePrompt, /actual talents/);
  assert.doesNotMatch(compiled.negativePrompt, /matter how hard/);
});

test("compileImagePrompt converts character-card appearance prose into compact avatar tags", () => {
  const settings = createDefaultImageStyleProfileSettings();
  const compiled = compileImagePrompt({
    kind: "avatar",
    prompt:
      "Veronica is in her early forties, tall and statuesque at 5'10\", with an upright, commanding posture. " +
      "Her dark auburn hair is swept into an elegant updo with a few deliberate loose strands framing sharp cheekbones. " +
      "Her eyes are a piercing hazel-green, framed by subtle smoky makeup that lends her gaze a hypnotic intensity. " +
      "She favors tailored, sophisticated attire - a fitted black blazer over a deep burgundy blouse, slim trousers, and polished heeled boots - accented with a single statement ring and reading glasses she often perches at the tip of her nose. " +
      "Her nails are immaculate and lacquered dark red, and she moves with the unhurried grace of someone perfectly aware she holds the room.",
    styleProfiles: settings,
    styleProfileId: "photorealistic",
    imageDefaults: {
      version: 1,
      service: "automatic1111",
      seed: -1,
      automatic1111: {
        promptPrefix: "<lora:dmd2_sdxl_4step_lora_fp16:1>",
        negativePromptPrefix: "",
        sampler: "Euler a",
        scheduler: "",
        steps: 20,
        cfgScale: 7,
        clipSkip: null,
        restoreFaces: false,
        denoisingStrength: 0.6,
      },
    },
  });

  assert.ok(compiled.prompt.length <= 140, compiled.prompt);
  assert.equal(compiled.prompt.split(", ")[0], "<lora:dmd2_sdxl_4step_lora_fp16:1>", compiled.prompt);
  assert.match(compiled.prompt, /centered face-and-shoulders portrait/);
  assert.match(compiled.prompt, /dark auburn hair/);
  assert.match(compiled.prompt, /hazel-green eyes/);
  assert.match(compiled.prompt, /early forties|black blazer|elegant updo|smoky makeup|tall/);
  assert.doesNotMatch(compiled.prompt, /Veronica is/);
  assert.doesNotMatch(compiled.prompt, /Her eyes are/);
  assert.doesNotMatch(compiled.prompt, /holds the room/);
  assert.doesNotMatch(compiled.prompt, /\.\s+[A-Z]/);
});

test("compileImagePrompt collapses equivalent portrait composition tags from saved profiles", () => {
  const settings = createDefaultImageStyleProfileSettings();
  const photorealistic = settings.profiles.find((profile) => profile.id === "photorealistic");
  assert.ok(photorealistic);
  photorealistic.subjectTags.avatar = "single subject, centered realistic avatar portrait";

  const compiled = compileImagePrompt({
    kind: "avatar",
    prompt: "female, centered face-and-shoulders portrait, grey eyes, dark auburn hair, black blazer",
    styleProfiles: settings,
    styleProfileId: "photorealistic",
    imageDefaults: {
      version: 1,
      service: "automatic1111",
      seed: -1,
      automatic1111: {
        promptPrefix: "<lora:dmd2_sdxl_4step_lora_fp16:1>",
        negativePromptPrefix: "",
        sampler: "Euler a",
        scheduler: "",
        steps: 20,
        cfgScale: 7,
        clipSkip: null,
        restoreFaces: false,
        denoisingStrength: 0.6,
      },
    },
  });

  assert.match(compiled.prompt, /centered face-and-shoulders portrait|centered realistic avatar portrait/);
  assert.match(compiled.prompt, /grey eyes/);
  assert.match(compiled.prompt, /dark auburn hair/);
  assert.match(compiled.prompt, /black blazer/);
  assert.ok(
    !(
      compiled.prompt.includes("centered face-and-shoulders portrait") &&
      compiled.prompt.includes("centered realistic avatar portrait")
    ),
    compiled.prompt,
  );
  assert.ok(compiled.diagnostics.removedPositiveDuplicates.includes("centered realistic avatar portrait"));
});
