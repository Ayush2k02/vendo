/**
 * The chrome registry — the data file behind the spec lane ("Custom Views"
 * prototype slice, bench-only). Eight workhorse components a view spec may
 * name, each entry pointing at the REAL production spec (`kitSpec()` from
 * @vendoai/core — the same zod prop schemas, prop classes, and docs the
 * engine itself consumes) plus the two things a view spec adds on top:
 * which data-class prop the bound tool result fills (the data slot) and
 * whether host actions may attach (the action slot, rendered as the real
 * Button).
 *
 * Every entry corresponds to a component the production tree renderer
 * actually draws (`PREWIRED_COMPONENTS[name] ?? KIT_COMPONENTS[name]` in
 * packages/ui/src/tree/renderer.tsx — a drift test pins this). Two honesty
 * notes: "Stat" and "Button" are legacy-prewired names in tree wire, so the
 * renderer draws packages/ui/src/tree/branded.tsx's implementations, whose
 * prop surfaces are supersets of the Kit specs validated here; the other six
 * names resolve to the Kit implementations the specs describe directly.
 */
import { kitSpec, type KitComponentSpec, type PropSpec } from "@vendoai/core";

export interface ChromeDataSlot {
  /** The data-class prop the bound tool's result fills at render. */
  prop: string;
  /** Accepted data shape, in model-facing words (also the validator's vocabulary). */
  shape: string;
}

export interface ChromeEntry {
  /** The name a spec piece's `use` field may name. */
  use: string;
  /** The REAL production component spec (zod props + classes + docs). */
  spec: KitComponentSpec;
  /** Absent = a piece of this component binds no tool (Button: actions only;
   *  Callout: copy only). */
  dataSlot?: ChromeDataSlot;
  /** Data-class props beyond the primary slot a piece may fill via `bind`
   *  (dot-paths into the same tool result), e.g. Progress `max`. */
  extraDataProps?: readonly string[];
  /** Authorable props a piece of this component MUST set even though the kit
   *  schema leaves them optional (a Callout with no title renders empty). */
  requireProps?: readonly string[];
  /** Renderer-owned layout class — the spec itself carries ZERO layout.
   *  Consecutive tiles share a grid row; blocks get the full width. */
  layout: "tile" | "block";
  /** Whether `actions[]` may attach to a piece (rendered as real Buttons). */
  actionSlots: boolean;
}

/** A registry entry's spec is resolved from the production catalog at module
 *  load — a name the catalog no longer carries is a crash, never drift. */
function entry(use: string, rest: Omit<ChromeEntry, "use" | "spec">): ChromeEntry {
  const spec = kitSpec(use);
  if (spec === undefined) throw new Error(`chrome registry names "${use}", which @vendoai/core's kit catalog does not carry`);
  return { use, spec, ...rest };
}

export const CHROME_REGISTRY: readonly ChromeEntry[] = [
  entry("Stat", {
    dataSlot: { prop: "value", shape: "one number or string — use `select` to point at a single field of the tool result" },
    layout: "tile",
    actionSlots: false,
  }),
  entry("Sparkline", {
    dataSlot: { prop: "data", shape: "an array of numbers, or rows read through the `valueKey` prop" },
    layout: "tile",
    actionSlots: false,
  }),
  entry("DataTable", {
    dataSlot: { prop: "rows", shape: "an array of record objects (rows)" },
    layout: "block",
    actionSlots: true,
  }),
  entry("CardList", {
    dataSlot: { prop: "items", shape: "an array of record objects (one card each)" },
    layout: "block",
    actionSlots: true,
  }),
  entry("LineChart", {
    dataSlot: { prop: "data", shape: "an array of point objects carrying the `xKey` field and every `series` key" },
    layout: "block",
    actionSlots: false,
  }),
  entry("BarChart", {
    dataSlot: { prop: "data", shape: "an array of point objects carrying the `xKey` field and every `series` key" },
    layout: "block",
    actionSlots: false,
  }),
  entry("DonutChart", {
    dataSlot: { prop: "data", shape: "an array of slice objects carrying the `categoryKey` and `valueKey` fields" },
    layout: "block",
    actionSlots: false,
  }),
  entry("Progress", {
    dataSlot: { prop: "value", shape: "one number — a ratio 0..1, or a raw value with `bind: {\"max\": \"<field>\"}` for the denominator" },
    extraDataProps: ["max"],
    layout: "tile",
    actionSlots: false,
  }),
  entry("Callout", {
    // Copy-only notice (tone + title). The honest place for a caveat on an
    // otherwise-grounded view; for a fully ungrounded ask the lane refuses
    // instead (format.ts specRefusalSchema → the Kit Disclaimer).
    requireProps: ["title"],
    layout: "block",
    actionSlots: false,
  }),
  entry("Button", {
    // No data slot: a Button piece is pure action surface — its `actions[]`
    // ARE the buttons (label + host tool + params), action-gated like every
    // mutation in the product.
    layout: "block",
    actionSlots: true,
  }),
];

export function chromeEntry(use: string): ChromeEntry | undefined {
  return CHROME_REGISTRY.find((candidate) => candidate.use === use);
}

/** The props a spec piece may set: config + copy only. Data props are filled
 *  by the compiler from the bound tool result — hand-typing them is law 1's
 *  "hand-typed business data" and the validator rejects it. */
export function authorableProps(entryOrUse: ChromeEntry | string): Array<[string, PropSpec]> {
  const found = typeof entryOrUse === "string" ? chromeEntry(entryOrUse) : entryOrUse;
  if (found === undefined) return [];
  return Object.entries(found.spec.props).filter(([, prop]) => prop.cls !== "data");
}

/** The registry rendered for the authoring context — same generated-from-spec
 *  discipline as the engine's `kitPrompt()`: hand-written component lists are
 *  dead, so this renders straight off the entries above. */
export function registryPrompt(): string {
  const sections = CHROME_REGISTRY.map((item) => {
    const lines = [`## ${item.use}`, item.spec.summary];
    if (item.dataSlot !== undefined) {
      lines.push(`Data slot: the bound tool's result fills \`${item.dataSlot.prop}\` — expects ${item.dataSlot.shape}.`);
      if (item.extraDataProps !== undefined && item.extraDataProps.length > 0) {
        lines.push(`Extra data props via \`bind\`: ${item.extraDataProps.map((prop) => `\`${prop}\``).join(", ")} (dot-paths into the same tool result).`);
      }
    } else {
      lines.push("No data slot: give this piece no `tool`.");
    }
    if (item.requireProps !== undefined && item.requireProps.length > 0) {
      lines.push(`Required here: ${item.requireProps.map((prop) => `\`${prop}\``).join(", ")}.`);
    }
    lines.push(item.actionSlots
      ? "Action slots: `actions[]` may attach; each renders as an action-gated button."
      : "Action slots: none — `actions[]` must be empty or absent.");
    const props = authorableProps(item);
    if (props.length > 0) {
      lines.push("Authorable props (config/copy only — data props are bound for you):");
      for (const [name, prop] of props) {
        lines.push(`- \`${name}\` [${prop.cls}]${prop.required ? " (required)" : ""} — ${prop.doc}`);
      }
    }
    return lines.join("\n");
  });
  return sections.join("\n\n");
}
