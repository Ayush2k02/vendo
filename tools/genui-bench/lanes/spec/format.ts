/**
 * The view-spec format — the whole model output of the spec lane. JSON, not
 * code. Two alternatives, one output:
 *
 *   - a VIEW SPEC: a flat list of pieces over the chrome registry, each
 *     binding one host tool (data) and optionally host actions. ZERO layout —
 *     no rows, grids, widths, or ordering hints; a piece may name a `section`
 *     (a copy string) and the compiler owns everything visual (compile.ts);
 *   - a REFUSAL: when the host's tool surface cannot ground the ask, the
 *     model abstains and names what is missing. Compiled onto the Kit's
 *     Disclaimer — the same "no tool backs the ask" chrome the vendo engine
 *     uses — so abstention renders brand-native, never as an error.
 */
import { z } from "zod";

/** Input for one host-tool call (a data query or an action payload). */
const paramsSchema = z.record(z.string(), z.unknown());

/** A dot-path into the tool result: field names / array indexes
 *  ("data", "0.sparkline"). Empty/absent = the whole result. */
const dotPath = z.string().regex(/^$|^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*$/, "must be a dot-path of field names, e.g. \"data\" or \"0.sparkline\"");

export const specActionSchema = z.object({
  /** Button text — shown as authored. */
  label: z.string().min(1),
  /** The host tool the button fires (action-gated, like every product mutation). */
  tool: z.string().min(1),
  params: paramsSchema.optional(),
});
export type SpecAction = z.infer<typeof specActionSchema>;

export const specPieceSchema = z.object({
  /** A chrome-registry component name. */
  use: z.string().min(1),
  /** Copy: consecutive pieces sharing a `section` render as one framed,
   *  headed group (the compiler's Surface pattern — still zero layout). */
  section: z.string().min(1).optional(),
  /** The host tool whose result fills the component's data slot. */
  tool: z.string().min(1).optional(),
  /** Input for that tool call. */
  params: paramsSchema.optional(),
  /** Dot-path selecting the primary data slot's value from the tool result. */
  select: dotPath.optional(),
  /** Extra data props (beyond the primary slot) → dot-paths into the SAME
   *  tool result, e.g. Progress: { "max": "target" }. */
  bind: z.record(z.string(), dotPath).optional(),
  /** Config/copy props only — data props are compiler-bound (law 1). */
  props: paramsSchema.optional(),
  actions: z.array(specActionSchema).optional(),
});
export type SpecPiece = z.infer<typeof specPieceSchema>;

/** A view spec may not exceed this many pieces — a bench-honesty bound, so a
 *  runaway generation fails loudly instead of compiling a 100-piece app. */
export const MAX_PIECES = 12;

export const viewSpecSchema = z.object({
  /** The view's heading (copy). */
  title: z.string().min(1),
  components: z.array(specPieceSchema).min(1).max(MAX_PIECES),
});
export type ViewSpec = z.infer<typeof viewSpecSchema>;

/** The typed abstention: the ask cannot be grounded in the host's tools. */
export const specRefusalSchema = z.object({
  refusal: z.object({
    /** Why the host can't ground this ask, in user-facing words. */
    reason: z.string().min(1),
    /** The capabilities the host would need (names the gap, not a tool id). */
    missing: z.array(z.string().min(1)).optional(),
  }),
});
export type SpecRefusal = z.infer<typeof specRefusalSchema>;

/** The model sometimes fences the JSON despite the prompt asking for raw
 *  output; the first fenced block wins, else the raw text. */
export function extractJson(text: string): string {
  const fenced = [...text.matchAll(/```[\w-]*\r?\n([\s\S]*?)```/g)].map((match) => (match[1] as string).trim());
  return fenced.length > 0 ? (fenced[0] as string) : text.trim();
}
