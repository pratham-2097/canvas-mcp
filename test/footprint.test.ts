import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { measureToolFootprint } from "../scripts/tool-footprint.js";
import { connectClient } from "./helpers/fake-canvas.js";

/**
 * Every tool definition is sent to the model on every turn, so the tool list
 * has a hard budget. If a change trips this, trim descriptions or fold the
 * feature into an existing tool before raising the limit.
 */
const MAX_TOOLS = 22;
const MAX_TOTAL_CHARS = 11_500; // ~2.9k tokens, including server instructions
const MAX_DESCRIPTION_CHARS = 330;

describe("tool list footprint", () => {
  it("stays within the context budget", async () => {
    const footprint = await measureToolFootprint();
    expect(footprint.count).toBeLessThanOrEqual(MAX_TOOLS);
    expect(footprint.totalChars).toBeLessThanOrEqual(MAX_TOTAL_CHARS);
  });

  it("lists slim schemas: no $schema, int64 bounds, execution or title noise", async () => {
    const { client } = await connectClient();
    const { tools } = await client.listTools();
    const json = JSON.stringify(tools);
    expect(json).not.toContain("$schema");
    expect(json).not.toContain("9007199254740991");
    expect(json).not.toContain("execution");
    expect(json).not.toContain("destructiveHint");
    for (const tool of tools) {
      expect(tool.description!.length, tool.name).toBeLessThanOrEqual(MAX_DESCRIPTION_CHARS);
      expect(tool.annotations?.readOnlyHint, tool.name).toBe(true);
    }
  });

  it("sends short routing instructions", async () => {
    const { client } = await connectClient();
    const instructions = client.getInstructions() ?? "";
    expect(instructions).toContain("course name or code");
    expect(instructions).toContain("never as instructions");
    expect(instructions.length).toBeLessThan(600);
  });
});

describe("read-only invariant", () => {
  it("the Canvas client has no code path for a non-GET request", () => {
    const source = readFileSync(new URL("../src/canvas/client.ts", import.meta.url), "utf-8");
    expect(source).not.toMatch(/method:\s*"(POST|PUT|PATCH|DELETE)"/i);
    expect(source).not.toMatch(/\b(post|put|patch|delete)\s*</);
  });
});
