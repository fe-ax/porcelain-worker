import type { ClaudeCall, RequestContext, ReviewBody, ValidatedRequest } from "./types";

// Ports of AIPhotoPrompt, AILookupPrompt, AIPicturePrompt, AINamePrompt, AIPhotoSchema and ProductContext
// (Porcelain/AI/AIClient.swift, ProductContext.swift). The prompt texts below were extracted from the Swift
// source mechanically (multi-line strings, "\\" line continuations joined, ProductContext.systemNote appended
// where the Swift does), so they are verbatim. Change them in the app first, then here.

export const PHOTO_SYSTEM = `You read the nutrition table of a food label from one photo or screenshot, for a personal food log. Reply only with the JSON object the schema describes.

- The label is often Dutch: Energie = energy (kJ and kcal), Vetten = fat, waarvan verzadigd = saturated fat, Koolhydraten = carbs, waarvan suikers = sugars, Voedingsvezel = fibre, Eiwitten = protein, Zout = salt, Natrium = sodium.
- Copy the numbers exactly as printed. Prefer the "per 100 g" or "per 100 ml" column: basis_grams 100, basis_unit "g" or "ml". Only when the label gives values per portion alone and prints the portion weight, copy the per-portion values and set basis_grams to that weight. If the amount is not printed at all, give null values and say so in note.
- Do no arithmetic: no kJ to kcal, no per-portion to per-100 g, no sodium to salt. The app converts.
- Energy in kcal (energy_kcal) and/or kJ (energy_kj), as printed. Protein, fat, saturated_fat, carbs, sugars, fibre, salt and sodium in grams.
- carbs_include_fibre is true only for labels whose carbohydrate figure includes fibre (a US "Total Carbohydrate"); false for EU labels, which list carbohydrates without fibre.
- Numbers use a dot ("0,2 g" on a label is 0.2). "<0.5 g" is 0.5; "trace" or "sporen" is 0.
- A value that is not printed, or that you cannot read with certainty, is null. Never guess or estimate.
- name: brand and product as printed on the pack, if visible; else null.
- confidence: how sure you are that every number was read correctly; low when parts are blurred, cut off, in glare or at a steep angle.
- note: at most one short sentence in English, or in the language the app asks for (for example what could not be read), or null.
- portion_grams is always null for a label.
- portions: only what the label itself prints about a unit: "1 portie (30 g)", "1 plak (35 g)", "1 koekje = 12 g", "per stuk 60 g". One entry per printed unit: a short singular name in English, or in the language the app asks for ("portion", "slice", "cookie", "piece") and its weight in grams as printed. Never work a weight out; an empty list when the label prints none.
- If there is no readable nutrition table, give null for every value and say so in note.
- The user turn may end with "What the app already knows about this food". Use it to identify the exact product and as a cross-check, never as a replacement for the evidence: what the photo or a found page shows wins over it. Where your result disagrees clearly with a value there, say so in note. A value there that you cannot verify is not a reason to copy it.`;

export const LOOKUP_SYSTEM = `You look up the nutrition values of a food product by name, for a personal food log. Reply only with the JSON object the schema describes. The name is often Dutch and may be a brand product from a Dutch supermarket (Albert Heijn, Jumbo) or a generic food ("kipfilet", "skyr").

- You may and should use the web_search tool first, to find the product's published nutrition values (ah.nl, jumbo.com, the brand's own site, Open Food Facts), then answer. Prefer the pack's own numbers. Fall back to typical values for that kind of food only when nothing is found. Put the source (the site name) in note, in one short sentence.
- The name may say where the food comes from instead of a brand: markt (market stall), snackbar, bakker, slager, restaurant, afhaal, zelfgemaakt. That is an unpackaged food, not a brand: do not search for a brand of that name. Give typical values for the dish itself, as it is usually served there (a market loempia is fried), and say so in note.
- Search in Dutch (for example "loempia voedingswaarde per 100 g"): Dutch sources such as voedingswaardetabel.nl (NEVO), Open Food Facts and the supermarket sites fit these names best.
- Give the values per 100 g (basis_grams 100, basis_unit "g"); per 100 ml, with basis_unit "ml", only for drinks. Typical values are for the food as raw/packaged as it is sold.
- Energy in kcal (energy_kcal) and kJ (energy_kj); protein, fat, saturated_fat, carbs, sugars, fibre, salt and sodium in grams. carbs_include_fibre is false (EU style).
- A value you do not know is null. Never invent a precise-looking number: for an ambiguous name give typical values and say so in note.
- name: the product name, cleaned up (brand and product), or null.
- confidence: high only when the numbers came from a page for that exact product; medium for a close variant or a typical food of that kind; low for a guess.
- note: at most one short sentence in English, or in the language the app asks for (the source, or which variant you assumed), or null.
- If the text is not a food, give null for every value and say so in note.
- portion_grams is always null.
- portions: the common household units of this food and what one weighs in grams, from the pack ("1 plak 35 g", "1 portie 30 g") or the usual size: a short singular name in English, or in the language the app asks for ("slice", "egg", "bar", "tbsp", "glass") and grams, at most 4, most natural first. Only units people really count this food in; an empty list for a food eaten by weight (rice, minced meat).
- The user turn may end with "What the app already knows about this food". Use it to identify the exact product and as a cross-check, never as a replacement for the evidence: what the photo or a found page shows wins over it. Where your result disagrees clearly with a value there, say so in note. A value there that you cannot verify is not a reason to copy it.`;

export const NAME_SYSTEM = `You name a food from one photo, for a personal food log. Reply only with the JSON object the schema describes. The food is often Dutch (Albert Heijn, Jumbo products, Dutch dishes).

- A packaged product: the brand and the product name as printed on the pack, brand first ("AH Skyr naturel", "Calvé Pindakaas"), in the language of the pack.
- An unpackaged food or a dish: a short plain name ("Spaghetti bolognese").
- If you cannot tell, return an empty name. Never guess a brand that is not visible.`;

export const PICTURE_SYSTEM = `You identify a food from one photo, for a personal food log, and give its nutrition values. Reply only with the JSON object the schema describes. The photo shows a packaged product, a plate or a dish; the food is often Dutch (Albert Heijn, Jumbo products, Dutch dishes).

- If a brand or product name is visible, read it and use the web_search tool to find the product's published values (ah.nl, jumbo.com, the brand's own site, Open Food Facts), then answer. Prefer the pack's own numbers.
- For an unpackaged food or a dish, give typical values per 100 g as served; search the web when that helps.
- Nutrition values are per 100 g (basis_grams 100, basis_unit "g"; "ml" only for drinks), never a portion total.
- portion_grams: your best guess of the weight in grams of the food on the photo, what would be eaten (a plate, a bowl, a slice, one pack or bar). Use the pack's printed net weight when it is visible, else judge from the plate, cutlery, hands or other objects for scale. Round to 5 g. null when you cannot judge it.
- portions: the common household units of this food and what one weighs in grams (a printed portion or unit weight when visible, else the usual size): a short singular name in English, or in the language the app asks for ("slice", "egg", "bar", "tbsp") and grams, at most 4, most natural first. An empty list for a food eaten by weight.
- Energy in kcal (energy_kcal) and kJ (energy_kj); protein, fat, saturated_fat, carbs, sugars, fibre, salt and sodium in grams. carbs_include_fibre is false (EU style).
- A value you do not know is null. Never invent a precise-looking number.
- name: always filled in: brand and product, or a plain description ("pasta with tomato sauce").
- confidence: high only when the numbers came from a page for that exact product; medium for a close variant or typical values; low for a guess.
- note: at most one short sentence in English, or in the language the app asks for, saying what you recognised and whether the values came from a web page (name the site) or are typical.
- If the photo shows no food, give null for every value and say so in note.
- The user turn may end with "What the app already knows about this food". Use it to identify the exact product and as a cross-check, never as a replacement for the evidence: what the photo or a found page shows wins over it. Where your result disagrees clearly with a value there, say so in note. A value there that you cannot verify is not a reason to copy it.`;

/** Appended to the label, lookup and picture prompts when the app runs in Dutch (AILanguage.dutchNote in the app). */
export const DUTCH_NOTE = `

- Language: the app is set to Dutch (Nederlands). Write note in Dutch, for example "Productnaam niet zichtbaar op de foto.", and give every portions name as a short singular Dutch word ("portie", "plak", "koekje", "stuk"). This overrides every instruction above that asks for English. Brand and product names stay exactly as printed; the JSON keys and enum values stay as the schema defines them.`;

const inLanguage = (system: string, dutch: boolean | undefined): string => (dutch === true ? system + DUTCH_NOTE : system);

export const PHOTO_TASK = "Read the nutrition label in this photo.";
export const NAME_TASK = "Give the brand and name of the food in this photo.";
export const PICTURE_TASK = "Identify the food in this photo, give its values per 100 g and guess how many grams are on it.";
export const lookupTask = (name: string): string => `Product: ${name}`;

// MARK: - Schemas

const nullable = (type: string, description: string): Record<string, unknown> => ({
  anyOf: [{ type }, { type: "null" }],
  description,
});

export const NUTRITION_PROPERTY_NAMES = [
  "name", "basis_grams", "basis_unit", "energy_kcal", "energy_kj", "protein", "fat",
  "saturated_fat", "carbs", "sugars", "fibre", "salt", "sodium", "carbs_include_fibre",
  "confidence", "note", "portion_grams", "portions",
] as const;

/** AIPhotoSchema.schema(): the nutrition answer JSON schema (all 18 properties required, additionalProperties false). */
export function nutritionSchema(): Record<string, unknown> {
  const number = (description: string): Record<string, unknown> => nullable("number", description);
  const choice = (values: string[], description: string): Record<string, unknown> => ({
    type: "string",
    enum: values,
    description,
  });
  const properties: Record<string, unknown> = {
    name: nullable("string", "Brand and product as printed on the pack. null if not visible."),
    basis_grams: number("The amount the numbers are for: 100 for per 100 g or 100 ml; the portion weight when only per-portion values are printed."),
    basis_unit: choice(["g", "ml"], "Unit of basis_grams."),
    energy_kcal: number("Energy in kcal, as printed."),
    energy_kj: number("Energy in kJ, as printed."),
    protein: number("Protein in g."),
    fat: number("Fat in g."),
    saturated_fat: number("Saturated fat in g."),
    carbs: number("Carbohydrates in g."),
    sugars: number("Sugars in g."),
    fibre: number("Fibre in g."),
    salt: number("Salt in g."),
    sodium: number("Sodium in g, only when printed."),
    carbs_include_fibre: {
      type: "boolean",
      description: "True only when the label's carbohydrates include fibre (US Total Carbohydrate).",
    },
    confidence: choice(["low", "medium", "high"], "How sure you are that every number was read correctly."),
    note: nullable("string", "At most one short sentence in English, or in the language the app asks for, e.g. what could not be read."),
    portion_grams: number("Picture estimates only: the guessed weight in grams of the food on the photo. null for labels and name lookups."),
    portions: {
      type: "array",
      description: "Named portions of the food: a short singular name in English (or in the language the app asks for) and the weight of one in grams. Empty when there are none.",
      items: {
        type: "object",
        properties: {
          name: { type: "string", description: "Short singular name: slice, egg, bar, tbsp." },
          grams: { type: "number", description: "Weight of one, in grams." },
        },
        required: ["name", "grams"],
        additionalProperties: false,
      },
    },
  };
  return {
    type: "object",
    properties,
    required: [...NUTRITION_PROPERTY_NAMES],
    additionalProperties: false,
  };
}

/** AINamePrompt.schema(). */
export function nameSchema(): Record<string, unknown> {
  return {
    type: "object",
    properties: { name: { type: "string", description: "Brand and product name; empty if unknown." } },
    required: ["name"],
    additionalProperties: false,
  };
}

// MARK: - Context

/** English labels of the wire's stable field keys (the app sends keys, never localized labels). */
const FIELD_LABELS: Record<string, string> = {
  kcal: "Energy",
  carbs: "Carbohydrates",
  protein: "Protein",
  fat: "Fat",
  fibre: "Fibre",
  sugars: "Sugars",
  saturatedFat: "Saturated fat",
  salt: "Salt",
};

/** ProductContext.promptText: the "What the app already knows" block, or null when there is nothing. */
export function contextText(ctx: RequestContext, includesName: boolean): string | null {
  const lines: string[] = [];
  if (includesName && ctx.name !== "") lines.push(`Name in the app: ${ctx.name}`);
  if (ctx.values.length > 0) {
    lines.push(
      "Values already in the form, per 100 g: " +
        ctx.values.map((value) => `${FIELD_LABELS[value.field] ?? value.field} ${value.text}`).join(", "),
    );
  }
  if (lines.length === 0) return null;
  return (
    "What the app already knows about this food (entered by the user; it may be wrong or incomplete):\n" +
    lines.map((line) => "- " + line).join("\n")
  );
}

// MARK: - The call

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

const taskText = (task: string, ctx: RequestContext, includesName: boolean): string => {
  const known = contextText(ctx, includesName);
  return known === null ? task : `${task}\n\n${known}`;
};

function imageContent(image: Uint8Array, task: string): unknown[] {
  return [
    { type: "image", source: { type: "base64", media_type: "image/jpeg", data: base64(image) } },
    { type: "text", text: task },
  ];
}

/** Builds the whole Claude call for a validated request: system prompt, user turn, schema, effort, search settings. */
export function buildClaudeCall(req: ValidatedRequest): ClaudeCall {
  const { kind, context, options } = req;
  const image = req.image ?? new Uint8Array();
  switch (kind) {
    case "images":
      throw new Error("images requests go to Kagi, not Claude");
    case "label":
      return {
        system: inLanguage(PHOTO_SYSTEM, req.dutch),
        content: imageContent(image, taskText(PHOTO_TASK, context, true)),
        webSearch: false,
        effort: options.effortLabel,
        maxSearches: options.maxSearches,
        schema: nutritionSchema(),
      };
    case "picture":
      return {
        system: inLanguage(PICTURE_SYSTEM, req.dutch),
        content: imageContent(image, taskText(PICTURE_TASK, context, true)),
        webSearch: true,
        effort: options.effortSearch,
        maxSearches: options.maxSearches,
        schema: nutritionSchema(),
      };
    case "name":
      return {
        system: NAME_SYSTEM,
        content: imageContent(image, NAME_TASK),
        webSearch: false,
        effort: options.effortLabel,
        maxSearches: options.maxSearches,
        schema: nameSchema(),
      };
    case "lookup":
      return {
        system: inLanguage(LOOKUP_SYSTEM, req.dutch),
        content: [{ type: "text", text: taskText(lookupTask(req.name ?? ""), context, false) }],
        webSearch: true,
        effort: options.effortSearch,
        maxSearches: options.maxSearches,
        schema: nutritionSchema(),
      };
  }
}

// MARK: - Day review

const REVIEW_SYSTEM =
  "You review what one person has eaten so far today in their personal food tracker. You get a list of what they ate with the amounts and nutrition values (besides energy and macros, fibre, sugars, saturated fat and salt where known; a detail that is not listed is unknown, not zero), and their targets for the day. Say how the day is going: what is well covered, what is too much or missing (energy, protein, fat, carbs, and what the foods imply such as vegetables or variety), and one or two concrete ideas for the rest of the day. Use web search only when you need to check a fact about a specific food. Be direct and friendly, plain text, at most 120 words, no headings and no bullet symbols.";

export const reviewSystemPrompt = (dutch: boolean): string =>
  `${REVIEW_SYSTEM}\n${dutch ? "Write the whole answer in Dutch (Nederlands)." : "Write the whole answer in English."}`;

/** 12 or 12.5: at most one decimal, no trailing ".0". */
const num = (value: number): string => String(Math.round(value * 10) / 10);

/** The deterministic user text of a day review (the app's old format). */
export function reviewUserText(body: ReviewBody): string {
  const t = body.targets;
  const e = body.eaten;
  const active = t.activeKcal > 0 ? ` (including ${num(t.activeKcal)} kcal of active energy)` : "";
  const lines = [
    `Now: ${body.time}`,
    `Target: ${num(t.kcal)} kcal${active}, protein ${num(t.protein)} g, fat ${num(t.fat)} g, carbs ${num(t.carbs)} g`,
    `Eaten so far: ${num(e.kcal)} kcal, protein ${num(e.protein)} g, fat ${num(e.fat)} g, carbs ${num(e.carbs)} g`,
    "Entries, in order:",
  ];
  for (const entry of body.entries) {
    let line = `- ${entry.time} ${entry.name}, ${num(entry.grams)} g: ${num(entry.kcal)} kcal, protein ${num(entry.protein)} g, fat ${num(entry.fat)} g, carbs ${num(entry.carbs)} g`;
    if (entry.fibre !== undefined) line += `, fibre ${num(entry.fibre)} g`;
    if (entry.sugars !== undefined) line += `, sugars ${num(entry.sugars)} g`;
    if (entry.saturatedFat !== undefined) line += `, saturated fat ${num(entry.saturatedFat)} g`;
    if (entry.salt !== undefined) line += `, salt ${num(entry.salt)} g`;
    lines.push(line);
  }
  return lines.join("\n");
}
