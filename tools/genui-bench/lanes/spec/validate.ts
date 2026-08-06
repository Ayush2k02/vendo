/**
 * The view-spec validator — the constrained-generation half of the spec lane.
 * Three checks per piece, every one against a REAL surface, none invented:
 *   1. the component exists in the chrome registry;
 *   2. the bound tool (and every action tool) exists on the host fixture's
 *      tool surface, with params checked against the tool's own inputSchema;
 *   3. props parse against the component's REAL zod prop schemas
 *      (@vendoai/core kit specs) — config/copy only: a hand-typed data prop
 *      is law 1's "hand-typed business data" and is rejected structurally.
 * Piece-scoped: one bad piece never poisons its neighbours (the adapter
 * repairs once, then ships the valid pieces and reports the rest honestly).
 */
import { TREE_MAX_QUERIES } from "@vendoai/core";
import { CHROME_REGISTRY, authorableProps, chromeEntry, type ChromeEntry } from "./registry";
import { MAX_PIECES, specRefusalSchema, viewSpecSchema, type SpecPiece, type SpecRefusal, type ViewSpec } from "./format";

export interface HostToolLike {
  name: string;
  description: string;
  risk?: string;
  inputSchema?: Record<string, unknown>;
}

export interface PieceVerdict {
  index: number;
  use: string;
  tool?: string;
  errors: string[];
}

export interface SpecVerdict {
  /** Present when the top level parsed; pieces then carry per-piece verdicts. */
  spec?: ViewSpec;
  /** Present when the model returned the typed abstention instead of a spec. */
  refusal?: SpecRefusal["refusal"];
  /** Top-level failures (unparseable JSON, wrong shape, query budget). */
  specErrors: string[];
  pieces: PieceVerdict[];
}

export function validPieces(verdict: SpecVerdict): SpecPiece[] {
  const spec = verdict.spec;
  if (spec === undefined) return [];
  return verdict.pieces.filter((piece) => piece.errors.length === 0).map((piece) => spec.components[piece.index] as SpecPiece);
}

export function allErrors(verdict: SpecVerdict): string[] {
  return [
    ...verdict.specErrors,
    ...verdict.pieces.flatMap((piece) =>
      piece.errors.map((error) => `piece ${piece.index + 1} (${piece.use}): ${error}`),
    ),
  ];
}

/** Bounded structural check of a params object against a tool's JSON-Schema
 *  inputSchema: required keys present, no unknown keys (when the schema
 *  declares properties), and primitive `type` agreement per property. Not a
 *  full JSON-Schema validator — the honest slice a bench prototype needs. */
export function checkParams(
  params: Record<string, unknown>,
  inputSchema: Record<string, unknown> | undefined,
  label: string,
): string[] {
  if (inputSchema === undefined) return [];
  const errors: string[] = [];
  const properties = inputSchema.properties as Record<string, Record<string, unknown>> | undefined;
  const required = Array.isArray(inputSchema.required) ? (inputSchema.required as string[]) : [];
  for (const key of required) {
    if (!(key in params)) errors.push(`${label} is missing required param "${key}"`);
  }
  if (properties !== undefined && inputSchema.additionalProperties !== true) {
    for (const key of Object.keys(params)) {
      if (!(key in properties)) errors.push(`${label} has unknown param "${key}" (accepted: ${Object.keys(properties).join(", ") || "none"})`);
    }
  }
  if (properties !== undefined) {
    for (const [key, value] of Object.entries(params)) {
      const type = properties[key]?.type;
      if (typeof type !== "string") continue;
      const actual = Array.isArray(value) ? "array" : value === null ? "null" : typeof value;
      const matches = type === "integer" ? typeof value === "number" && Number.isInteger(value) : actual === type;
      if (!matches) errors.push(`${label} param "${key}" should be ${type}, got ${actual}`);
    }
  }
  return errors;
}

function checkProps(entry: ChromeEntry, piece: SpecPiece): string[] {
  const errors: string[] = [];
  const props = piece.props ?? {};
  const authorable = new Map(authorableProps(entry));
  const dataProps = new Set(Object.entries(entry.spec.props).filter(([, prop]) => prop.cls === "data").map(([name]) => name));

  for (const [name, value] of Object.entries(props)) {
    if (dataProps.has(name)) {
      errors.push(`prop "${name}" is a data prop — hand-typed business data is illegal (law 1); it is bound from the piece's tool result`);
      continue;
    }
    const prop = authorable.get(name);
    if (prop === undefined) {
      errors.push(`unknown prop "${name}" (authorable: ${[...authorable.keys()].join(", ") || "none"})`);
      continue;
    }
    const parsed = prop.schema.safeParse(value);
    if (!parsed.success) {
      errors.push(`prop "${name}": ${parsed.error.issues.map((issue) => issue.message).join("; ")}`);
    }
  }

  // Required authorable props are enforced on data-slot pieces (a Stat without
  // a label renders dishonestly); a Button piece's requireds (label) come from
  // its actions, checked below. Registry entries may require props the kit
  // schema leaves optional (a Callout with no title renders empty).
  if (entry.dataSlot !== undefined) {
    for (const [name, prop] of authorable) {
      if (prop.required && !(name in props)) errors.push(`required prop "${name}" is missing`);
    }
  }
  for (const name of entry.requireProps ?? []) {
    if (!(name in props)) errors.push(`required prop "${name}" is missing`);
  }
  return errors;
}

function checkPiece(piece: SpecPiece, index: number, toolsByName: Map<string, HostToolLike>): PieceVerdict {
  const errors: string[] = [];
  const entry = chromeEntry(piece.use);
  if (entry === undefined) {
    return {
      index,
      use: piece.use,
      ...(piece.tool === undefined ? {} : { tool: piece.tool }),
      errors: [`unknown component "${piece.use}" — the chrome registry has: ${CHROME_REGISTRY.map((item) => item.use).join(", ")}`],
    };
  }

  if (entry.dataSlot !== undefined) {
    if (piece.tool === undefined) {
      errors.push(`${entry.use} has a data slot ("${entry.dataSlot.prop}") — a \`tool\` is required`);
    } else {
      const tool = toolsByName.get(piece.tool);
      if (tool === undefined) errors.push(`this host does not expose tool "${piece.tool}"`);
      else errors.push(...checkParams(piece.params ?? {}, tool.inputSchema, `tool "${piece.tool}"`));
    }
  } else if (piece.tool !== undefined) {
    errors.push(`${entry.use} has no data slot — give it no \`tool\``);
  }

  errors.push(...checkProps(entry, piece));

  const bind = piece.bind ?? {};
  const extra = new Set(entry.extraDataProps ?? []);
  for (const prop of Object.keys(bind)) {
    if (!extra.has(prop)) {
      errors.push(`\`bind\` names "${prop}", which ${entry.use} does not accept (bindable: ${[...extra].join(", ") || "none"})`);
    }
  }
  if (Object.keys(bind).length > 0 && entry.dataSlot === undefined) {
    errors.push(`${entry.use} binds no tool — \`bind\` has nothing to read from`);
  }

  const actions = piece.actions ?? [];
  if (actions.length > 0 && !entry.actionSlots) {
    errors.push(`${entry.use} has no action slots — \`actions\` must be empty`);
  } else {
    for (const [actionIndex, action] of actions.entries()) {
      const tool = toolsByName.get(action.tool);
      if (tool === undefined) errors.push(`action ${actionIndex + 1} names tool "${action.tool}", which this host does not expose`);
      else errors.push(...checkParams(action.params ?? {}, tool.inputSchema, `action ${actionIndex + 1} ("${action.tool}")`));
    }
  }
  if (entry.use === "Button" && actions.length === 0) {
    errors.push("a Button piece is pure action surface — it needs at least one entry in `actions`");
  }

  return { index, use: piece.use, ...(piece.tool === undefined ? {} : { tool: piece.tool }), errors };
}

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Validate raw model text (JSON, possibly fenced) against the registry and
 *  the host's tool surface — or accept the typed refusal. Never throws. */
export function validateSpec(jsonText: string, hostTools: readonly HostToolLike[]): SpecVerdict {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (error) {
    return { specErrors: [`output is not valid JSON: ${error instanceof Error ? error.message : String(error)}`], pieces: [] };
  }
  // The typed abstention: `refusal` present means the model judged the ask
  // ungroundable. A payload carrying BOTH forms is contradictory.
  if (isPlainRecord(parsed) && "refusal" in parsed) {
    if ("components" in parsed) {
      return { specErrors: ["output carries both a refusal and components — answer with exactly one form"], pieces: [] };
    }
    const refused = specRefusalSchema.safeParse(parsed);
    if (!refused.success) {
      return {
        specErrors: refused.error.issues.map((issue) => `${issue.path.join(".") || "refusal"}: ${issue.message}`),
        pieces: [],
      };
    }
    return { refusal: refused.data.refusal, specErrors: [], pieces: [] };
  }

  const shaped = viewSpecSchema.safeParse(parsed);
  if (!shaped.success) {
    return {
      specErrors: shaped.error.issues.map((issue) => `${issue.path.join(".") || "spec"}: ${issue.message}`),
      pieces: [],
    };
  }

  const spec = shaped.data;
  const toolsByName = new Map(hostTools.map((tool) => [tool.name, tool]));
  const pieces = spec.components.map((piece, index) => checkPiece(piece, index, toolsByName));
  return { spec, specErrors: [], pieces };
}

// The compiled tree's query budget is satisfied structurally: a piece binds at
// most one query, so MAX_PIECES is the ceiling on unique queries. If the piece
// cap ever outgrows the tree cap, this trips at import and the validator needs
// a real budget check back.
if (MAX_PIECES > TREE_MAX_QUERIES) {
  throw new Error(`MAX_PIECES (${MAX_PIECES}) exceeds TREE_MAX_QUERIES (${TREE_MAX_QUERIES}) — add a query-budget check`);
}
