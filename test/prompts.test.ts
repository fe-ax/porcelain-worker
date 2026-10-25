import { describe, expect, it } from "vitest";
import {
  DUTCH_NOTE, LOOKUP_SYSTEM, NAME_SYSTEM, PHOTO_SYSTEM, PICTURE_SYSTEM, buildClaudeCall, contextText, nameSchema,
  nutritionSchema, NUTRITION_PROPERTY_NAMES,
} from "../src/prompts";
import type { ValidatedRequest } from "../src/types";

const options = { effortLabel: "low", effortSearch: "high", maxSearches: 5 } as const;
const image = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);

describe("ported prompts", () => {
  it("keep the Swift wording (spot checks of each prompt)", () => {
    expect(PHOTO_SYSTEM).toContain("Energie = energy (kJ and kcal), Vetten = fat");
    expect(PHOTO_SYSTEM).toContain("portion_grams is always null for a label.");
    expect(LOOKUP_SYSTEM).toContain("You may and should use the web_search tool first");
    expect(LOOKUP_SYSTEM).toContain("markt (market stall), snackbar");
    expect(PICTURE_SYSTEM).toContain("Round to 5 g. null when you cannot judge it.");
    expect(NAME_SYSTEM).toContain('("AH Skyr naturel", "Calvé Pindakaas")');
  });
  it("append ProductContext.systemNote to all but the name prompt", () => {
    const note = 'The user turn may end with "What the app already knows about this food".';
    for (const text of [PHOTO_SYSTEM, LOOKUP_SYSTEM, PICTURE_SYSTEM]) expect(text).toContain(note);
    expect(NAME_SYSTEM).not.toContain(note);
    expect(PHOTO_SYSTEM).toContain("say so in note.\n- The user turn may end");
  });
  it("have no leftover Swift line continuations or tabs", () => {
    for (const text of [PHOTO_SYSTEM, LOOKUP_SYSTEM, NAME_SYSTEM, PICTURE_SYSTEM]) {
      expect(text).not.toContain("\\");
      expect(text).not.toContain("\t");
    }
  });
});

describe("schemas", () => {
  it("nutrition schema has all 18 properties, required, closed", () => {
    const schema = nutritionSchema() as { properties: Record<string, unknown>; required: string[]; additionalProperties: boolean };
    expect(Object.keys(schema.properties)).toEqual([...NUTRITION_PROPERTY_NAMES]);
    expect(schema.required).toEqual([...NUTRITION_PROPERTY_NAMES]);
    expect(schema.required).toHaveLength(18);
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties["energy_kcal"]).toEqual({
      anyOf: [{ type: "number" }, { type: "null" }],
      description: "Energy in kcal, as printed.",
    });
  });
  it("name schema is {name: string}", () => {
    expect(nameSchema()).toEqual({
      type: "object",
      properties: { name: { type: "string", description: "Brand and product name; empty if unknown." } },
      required: ["name"],
      additionalProperties: false,
    });
  });
});

describe("contextText", () => {
  it("is null with nothing to say", () => {
    expect(contextText({ name: "", values: [] }, true)).toBeNull();
    expect(contextText({ name: "AH Skyr", values: [] }, false)).toBeNull();
  });
  it("renders English labels and the name", () => {
    expect(
      contextText({ name: "AH Skyr", values: [{ field: "kcal", text: "63" }, { field: "saturatedFat", text: "0,1" }] }, true),
    ).toBe(
      "What the app already knows about this food (entered by the user; it may be wrong or incomplete):\n" +
        "- Name in the app: AH Skyr\n- Values already in the form, per 100 g: Energy 63, Saturated fat 0,1",
    );
  });
});

describe("buildClaudeCall", () => {
  const base = (kind: ValidatedRequest["kind"], extra: Partial<ValidatedRequest> = {}): ValidatedRequest => ({
    kind, context: { name: "", values: [] }, options, ...extra,
  });

  it("label: image first, task text, no web search, label effort", () => {
    const call = buildClaudeCall(base("label", { image }));
    expect(call.system).toBe(PHOTO_SYSTEM);
    expect(call.webSearch).toBe(false);
    expect(call.effort).toBe("low");
    expect(call.content).toEqual([
      { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "/9j/2Q==" } },
      { type: "text", text: "Read the nutrition label in this photo." },
    ]);
  });
  it("dutch appends the language note to label, lookup and picture, never to name, and not when false", () => {
    for (const kind of ["label", "picture"] as const) {
      expect(buildClaudeCall(base(kind, { image, dutch: true })).system).toBe(buildClaudeCall(base(kind, { image })).system + DUTCH_NOTE);
      expect(buildClaudeCall(base(kind, { image, dutch: false })).system).not.toContain("the app is set to Dutch");
    }
    const lookup = buildClaudeCall(base("lookup", { name: "Skyr", dutch: true }));
    expect(lookup.system).toBe(LOOKUP_SYSTEM + DUTCH_NOTE);
    expect(buildClaudeCall(base("name", { image, dutch: true })).system).toBe(NAME_SYSTEM);
    expect(DUTCH_NOTE).toContain("This overrides every instruction above that asks for English.");
  });
  it("the English prompts let the app choose the language of the note and the portion names", () => {
    for (const system of [PHOTO_SYSTEM, LOOKUP_SYSTEM, PICTURE_SYSTEM]) {
      expect(system).toContain("in the language the app asks for");
      expect(system).not.toMatch(/one short English sentence|singular English name/);
    }
  });
  it("picture: web search, search effort, context appended", () => {
    const call = buildClaudeCall(base("picture", { image, context: { name: "Pasta", values: [{ field: "fat", text: "3" }] } }));
    expect(call.system).toBe(PICTURE_SYSTEM);
    expect(call.webSearch).toBe(true);
    expect(call.effort).toBe("high");
    expect((call.content[1] as { text: string }).text).toContain("\n\nWhat the app already knows about this food");
    expect((call.content[1] as { text: string }).text).toContain("Name in the app: Pasta");
  });
  it("lookup: text only, 'Product:' line, the name is not repeated from the context", () => {
    const call = buildClaudeCall(base("lookup", { name: "Skyr naturel", context: { name: "AH Skyr", values: [{ field: "kcal", text: "63" }] } }));
    expect(call.system).toBe(LOOKUP_SYSTEM);
    expect(call.content).toHaveLength(1);
    const text = (call.content[0] as { text: string }).text;
    expect(text.startsWith("Product: Skyr naturel\n\n")).toBe(true);
    expect(text).not.toContain("Name in the app");
    expect(text).toContain("Energy 63");
  });
  it("name: name prompt and schema, no search, no context", () => {
    const call = buildClaudeCall(base("name", { image }));
    expect(call.system).toBe(NAME_SYSTEM);
    expect(call.schema).toEqual(nameSchema());
    expect(call.webSearch).toBe(false);
  });
});
