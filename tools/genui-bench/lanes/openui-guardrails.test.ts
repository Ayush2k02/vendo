/**
 * Guardrail unit tests over the REAL parser and the REAL vendo-backed
 * library, plus the drift test pinning vendo-openui-library.ts to
 * @vendoai/core's KIT_SPECS (the library's schemas are DERIVED from the
 * Kit's spec surface; drift here would mean the prompt teaches components
 * the Kit does not have, or misses props it does).
 */
import { describe, expect, it } from "vitest";
import { KIT_SPECS } from "@vendoai/core";
import {
  boundTools,
  fixInstruction,
  programSnapshot,
  readCannot,
  refusalProgram,
  stripCannot,
  validateProgram,
} from "./openui-guardrails";
import {
  STOCK_FALLBACK_NAMES,
  VENDO_KIT_COMPONENT_NAMES,
  benchComponentNames,
  benchLibrary,
  benchLibrarySchema,
} from "./vendo-openui-library";

const HOST_TOOLS = ["host_listClients", "host_sendClientMessage"];

const validate = (program: string) =>
  validateProgram(program, HOST_TOOLS, benchLibrarySchema, benchComponentNames, STOCK_FALLBACK_NAMES);

describe("cannot protocol", () => {
  it("reads <Cannot> lines and strips them from program text", () => {
    const text = '<Cannot>No revenue data.</Cannot>\n<Cannot>No time tracking.</Cannot>';
    expect(readCannot(text)).toEqual(["No revenue data.", "No time tracking."]);
    expect(stripCannot(text)).toBe("");
    const mixed = 'root = Stack([x])\n<Cannot>One part is out of reach.</Cannot>';
    expect(readCannot(mixed)).toEqual(["One part is out of reach."]);
    expect(stripCannot(mixed)).toBe("root = Stack([x])");
  });

  it("the refusal program is VALID in the bench library (it must always render)", () => {
    const validation = validate(refusalProgram(['Your host has "no" revenue data.', "Second reason."]));
    expect(validation.findings.filter(({ severity }) => severity === "block")).toEqual([]);
    const snapshot = programSnapshot(validation.parsed);
    expect(Object.values(snapshot.components)).toContain("Disclaimer");
  });
});

describe("validateProgram", () => {
  it("an unknown tool binding is a block whose message TEACHES the real tools", () => {
    const validation = validate([
      'rev = Query("host_getRevenue", {}, [])',
      'root = Stack([DataTable(rev, [{key: "a"}])])',
    ].join("\n"));
    const block = validation.findings.find(({ where }) => where === 'tool "host_getRevenue"');
    expect(block?.severity).toBe("block");
    expect(block?.message).toContain("the host tools are: host_listClients, host_sendClientMessage");
    expect(boundTools(validation.parsed)).toEqual(["host_getRevenue"]);
  });

  it("an unknown component is a block carrying their enriched hint", () => {
    const validation = validate('root = Stack([Bogus("x")])');
    const block = validation.findings.find(({ message }) => message.includes('"Bogus"'));
    expect(block?.severity).toBe("block");
    expect(block?.message).toContain("Available components");
  });

  it("an unresolved reference is a block; an orphaned statement is a warn", () => {
    const unresolved = validate("root = Stack([ghost])");
    expect(unresolved.findings.some(({ where, severity }) => where === 'reference "ghost"' && severity === "block")).toBe(true);
    const orphaned = validate('root = Stack([Text("hi")])\nlost = Text("unreachable")');
    expect(orphaned.findings.some(({ where, severity }) => where === 'statement "lost"' && severity === "warn")).toBe(true);
  });

  it("a stock fallback component is recorded as a warn", () => {
    const validation = validate('root = Stack([md])\nmd = MarkDownRenderer("**hello**")');
    const warn = validation.findings.find(({ where }) => where === 'statement "md"');
    expect(warn?.severity).toBe("warn");
    expect(warn?.message).toContain("recorded fallback");
  });

  it("an empty answer is unpatchable", () => {
    expect(validate("").unpatchable).toBe(true);
    expect(validate('root = Stack([Text("x")])').unpatchable).toBe(false);
  });
});

describe("fix instruction", () => {
  it("is the findings themselves, patch semantics stated", () => {
    const instruction = fixInstruction([
      { severity: "block", where: 'tool "host_x"', message: "does not exist" },
    ]);
    expect(instruction).toContain('- tool "host_x": does not exist');
    expect(instruction).toContain("ONLY the statements that change");
    expect(instruction).toContain("<Cannot>");
  });
});

describe("vendo-openui-library drift against KIT_SPECS", () => {
  it("covers every Kit component with every spec prop, required flags intact", () => {
    const defs = (benchLibrarySchema.$defs ?? {}) as Record<
      string,
      { properties?: Record<string, unknown>; required?: string[] }
    >;
    for (const spec of KIT_SPECS) {
      expect(VENDO_KIT_COMPONENT_NAMES, `component ${spec.name} missing`).toContain(spec.name);
      const def = defs[spec.name];
      expect(def, `schema for ${spec.name} missing`).toBeDefined();
      const properties = Object.keys(def?.properties ?? {});
      const required = new Set(def?.required ?? []);
      for (const [prop, propSpec] of Object.entries(spec.props)) {
        // Callout's body is the one renamed prop: the Kit component takes the
        // notice text as React children, which openui-lang cannot express.
        if (spec.name === "Callout" && !(prop in (def?.properties ?? {}))) continue;
        expect(properties, `${spec.name}.${prop} missing`).toContain(prop);
        if (propSpec.required === true) {
          expect(required.has(prop), `${spec.name}.${prop} should be required`).toBe(true);
        }
      }
    }
  });

  it("the stock fallbacks are registered and are the ONLY non-Kit components", () => {
    const kit = new Set(VENDO_KIT_COMPONENT_NAMES);
    const extras = Object.keys(benchLibrary.components).filter((name) => !kit.has(name));
    expect(extras.sort()).toEqual([...STOCK_FALLBACK_NAMES].sort());
  });
});
