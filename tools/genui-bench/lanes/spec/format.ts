/**
 * The view-spec format — the whole model output of the spec lane. JSON, not
 * code: a flat list of pieces over the chrome registry, each binding one host
 * tool (data) and optionally host actions. ZERO layout — no rows, grids,
 * widths, or ordering hints; layout is the renderer's (see compile.ts).
 */
import { z } from "zod";

/** Input for one host-tool call (a data query or an action payload). */
const paramsSchema = z.record(z.string(), z.unknown());

/** `select` walks the tool result to the value the data slot receives:
 *  dot-separated field names / array indexes ("data", "0.sparkline").
 *  Absent/empty = the whole result. */
const selectSchema = z.string().regex(/^$|^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*$/, "select must be a dot-path of field names, e.g. \"data\" or \"0.sparkline\"");

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
  /** The host tool whose result fills the component's data slot. */
  tool: z.string().min(1).optional(),
  /** Input for that tool call. */
  params: paramsSchema.optional(),
  select: selectSchema.optional(),
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

/** The model sometimes fences the JSON despite the prompt asking for raw
 *  output; the first fenced block wins, else the raw text. */
export function extractJson(text: string): string {
  const fenced = [...text.matchAll(/```[\w-]*\r?\n([\s\S]*?)```/g)].map((match) => (match[1] as string).trim());
  return fenced.length > 0 ? (fenced[0] as string) : text.trim();
}
