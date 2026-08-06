/**
 * The spec renderer, first half: a deterministic compiler from a validated
 * view spec onto the PRODUCTION tree format (`vendo-genui/v2`). The second
 * half is the production renderer itself — the compiled AppDocument renders
 * through the same `/embed/<host>` host document the Vendo lane uses
 * (VendoProvider → AppFrame → the real Kit/prewired components, queries and
 * actions live against /api/tools). No new rendering code exists in this
 * lane; the "thin mapper" is this file.
 *
 * Layout is entirely owned here (the spec carries ZERO layout): a Stack with
 * a heading; consecutive pieces sharing a `section` render as the engine's
 * own group pattern (Surface → Text heading → Stack body); consecutive tile
 * pieces (Stat, Sparkline, Progress) share a Grid row; blocks run full
 * width; a piece's actions render as a Row of real Buttons under it. A piece
 * that failed validation after the repair round renders as an honest in-app
 * Callout naming its errors — per-piece failure, never a blank.
 *
 * A REFUSAL compiles onto the Kit's Disclaimer — the same "no tool backs the
 * ask" chrome the vendo engine ships — so abstention renders brand-native.
 */
import { createHash } from "node:crypto";
import {
  VENDO_APP_FORMAT,
  VENDO_TREE_FORMAT,
  validateTree,
  type AppDocument,
  type Json,
  type TreeNode,
  type TreeQuery,
} from "@vendoai/core";
import { chromeEntry, type ChromeEntry } from "./registry";
import type { SpecPiece, SpecRefusal, ViewSpec } from "./format";
import type { PieceVerdict } from "./validate";

/** `select`/`bind` dot-path → the JSON Pointer under the piece's query result. */
export function selectPointer(queryName: string, select: string | undefined): string {
  const base = `/${queryName}`;
  if (select === undefined || select === "") return base;
  return `${base}/${select.split(".").join("/")}`;
}

interface QueryPool {
  queries: TreeQuery[];
  keyed: Map<string, string>;
}

/** One query per unique (tool, params) pair — two pieces reading the same
 *  tool with the same input share a fetch, like the engine's declared
 *  queries. Names are q0, q1, … in first-use order. */
function queryFor(pool: QueryPool, tool: string, params: Record<string, unknown> | undefined): string {
  const key = JSON.stringify([tool, params ?? {}]);
  const existing = pool.keyed.get(key);
  if (existing !== undefined) return existing;
  const name = `q${pool.queries.length}`;
  pool.queries.push({ name, tool, ...(params === undefined || Object.keys(params).length === 0 ? {} : { input: params as Record<string, Json> }) });
  pool.keyed.set(key, name);
  return name;
}

/** One compiled piece: its top-level nodes (in render order) plus everything
 *  beneath them, and the layout class the top row participates in. */
interface Placed {
  tops: TreeNode[];
  nodes: TreeNode[];
  layout: "tile" | "block";
}

function placePiece(piece: SpecPiece, entry: ChromeEntry, id: string, pool: QueryPool): Placed {
  const nodes: TreeNode[] = [];
  const tops: TreeNode[] = [];
  const actions = piece.actions ?? [];

  if (entry.dataSlot !== undefined && piece.tool !== undefined) {
    const query = queryFor(pool, piece.tool, piece.params);
    const props: Record<string, Json> = {
      ...((piece.props ?? {}) as Record<string, Json>),
      [entry.dataSlot.prop]: { $path: selectPointer(query, piece.select) } as unknown as Json,
    };
    for (const [prop, path] of Object.entries(piece.bind ?? {})) {
      props[prop] = { $path: selectPointer(query, path) } as unknown as Json;
    }
    const node: TreeNode = { id, component: entry.use, source: "prewired", props };
    nodes.push(node);
    tops.push(node);
  } else if (entry.dataSlot === undefined && actions.length === 0) {
    // Copy-only piece (Callout): the component with its authored props.
    const node: TreeNode = { id, component: entry.use, source: "prewired", props: (piece.props ?? {}) as Record<string, Json> };
    nodes.push(node);
    tops.push(node);
  }

  if (actions.length > 0) {
    const buttons = actions.map((action, index): TreeNode => ({
      id: `${id}-action-${index}`,
      component: "Button",
      source: "prewired",
      props: {
        label: action.label,
        // The renderer's action binding: bound to onAction → POST /api/tools,
        // the same gate every product mutation rides.
        onClick: { $action: action.tool, ...(action.params === undefined ? {} : { payload: action.params as Json }) },
        ...(entry.use === "Button" ? (piece.props ?? {}) : {}),
      } as Record<string, Json>,
    }));
    const row: TreeNode = { id: `${id}-actions`, component: "Row", source: "prewired", props: { gap: 8 }, children: buttons.map((node) => node.id) };
    nodes.push(row, ...buttons);
    tops.push(row);
  }

  return { tops, nodes, layout: entry.layout };
}

/** The honest render of a piece that failed validation after the one repair
 *  round: a real Callout naming the piece and its errors, in place. */
function failurePlaced(verdict: PieceVerdict, id: string): Placed {
  const nodes: TreeNode[] = [
    {
      id,
      component: "Callout",
      source: "prewired",
      props: { tone: "warning", title: `Piece ${verdict.index + 1} (${verdict.use}) failed validation` },
      children: [`${id}-detail`],
    },
    {
      id: `${id}-detail`,
      component: "Text",
      source: "prewired",
      props: { text: verdict.errors.join(" · "), variant: "caption" },
    },
  ];
  return { tops: [nodes[0] as TreeNode], nodes, layout: "block" };
}

/** Lay a run of placed pieces out: consecutive tiles share a Grid row,
 *  everything else stacks. Returns the child-id list plus any Grid nodes. */
function layoutRun(placed: readonly Placed[], idPrefix: string): { childIds: string[]; nodes: TreeNode[] } {
  const childIds: string[] = [];
  const nodes: TreeNode[] = [];
  let tileRun: TreeNode[] = [];
  const flush = (): void => {
    if (tileRun.length === 0) return;
    const gridId = `${idPrefix}-grid-${childIds.length}`;
    nodes.push({
      id: gridId,
      component: "Grid",
      source: "prewired",
      props: { columns: Math.min(tileRun.length, 3), gap: 12 },
      children: tileRun.map((node) => node.id),
    });
    childIds.push(gridId);
    tileRun = [];
  };
  for (const item of placed) {
    if (item.layout === "tile" && item.tops.length === 1) {
      tileRun.push(item.tops[0] as TreeNode);
    } else {
      flush();
      childIds.push(...item.tops.map((node) => node.id));
    }
  }
  flush();
  return { childIds, nodes };
}

export interface CompiledSpec {
  document: AppDocument;
  queryCount: number;
  nodeCount: number;
}

const finishDocument = (name: string, nodes: TreeNode[], queries: TreeQuery[]): AppDocument => {
  const tree = {
    formatVersion: VENDO_TREE_FORMAT,
    root: "app",
    nodes,
    ...(queries.length === 0 ? {} : { queries }),
  };
  const gate = validateTree(tree);
  if (!gate.ok) throw new Error(`spec compiler produced an invalid tree: ${gate.error.message}`);
  return {
    format: VENDO_APP_FORMAT,
    id: `app_bench_spec_${createHash("sha256").update(JSON.stringify(tree)).digest("hex").slice(0, 8)}`,
    name,
    ui: "tree",
    tree,
  };
};

/**
 * Compile the spec's pieces in authored order. `verdicts` decides each
 * piece's fate: clean pieces render, failed pieces render their failure
 * Callout. Throws only on a compiler bug (the output is re-checked against
 * the production tree gate) — the adapter catches and fails the lane.
 */
export function compileSpec(spec: ViewSpec, verdicts: readonly PieceVerdict[]): CompiledSpec {
  const pool: QueryPool = { queries: [], keyed: new Map() };
  const nodes: TreeNode[] = [];
  const rootChildren: string[] = [];

  const title: TreeNode = {
    id: "title",
    component: "Text",
    source: "prewired",
    props: { text: spec.title, variant: "heading" },
  };
  nodes.push(title);
  rootChildren.push(title.id);

  // Group consecutive pieces by `section` (undefined = ungrouped at root).
  interface Group { section: string | undefined; placed: Placed[] }
  const groups: Group[] = [];
  for (const verdict of verdicts) {
    const id = `piece-${verdict.index}`;
    const piece = spec.components[verdict.index] as SpecPiece;
    const item = verdict.errors.length > 0
      ? failurePlaced(verdict, id)
      : placePiece(piece, chromeEntry(piece.use) as ChromeEntry, id, pool);
    if (item.tops.length === 0) continue;
    nodes.push(...item.nodes);
    const section = verdict.errors.length > 0 ? undefined : piece.section;
    const last = groups[groups.length - 1];
    if (last !== undefined && last.section === section) last.placed.push(item);
    else groups.push({ section, placed: [item] });
  }

  for (const [index, group] of groups.entries()) {
    const laid = layoutRun(group.placed, `g${index}`);
    nodes.push(...laid.nodes);
    if (group.section === undefined) {
      rootChildren.push(...laid.childIds);
      continue;
    }
    // The engine's own group pattern: Surface → Text heading → Stack body.
    const surfaceId = `section-${index}`;
    nodes.push(
      { id: surfaceId, component: "Surface", source: "prewired", children: [`${surfaceId}-title`, `${surfaceId}-body`] },
      { id: `${surfaceId}-title`, component: "Text", source: "prewired", props: { text: group.section, variant: "heading" } },
      { id: `${surfaceId}-body`, component: "Stack", source: "prewired", props: { gap: 12 }, children: laid.childIds },
    );
    rootChildren.push(surfaceId);
  }

  nodes.unshift({ id: "app", component: "Stack", source: "prewired", props: { gap: 16 }, children: rootChildren });
  const document = finishDocument(spec.title, nodes, pool.queries);
  return { document, queryCount: pool.queries.length, nodeCount: nodes.length };
}

/**
 * Compile the typed abstention onto the Kit's Disclaimer — vendo's own
 * refusal chrome ("when no tool backs the ask, say so — never invent data"),
 * rendered in the host document like any other spec output.
 */
export function compileRefusal(refusal: SpecRefusal["refusal"]): CompiledSpec {
  const nodes: TreeNode[] = [
    { id: "app", component: "Stack", source: "prewired", props: { gap: 12 }, children: ["refusal", ...(refusal.missing?.length ? ["missing"] : [])] },
    {
      id: "refusal",
      component: "Disclaimer",
      source: "prewired",
      props: { reason: refusal.reason, title: "This host can't ground that ask" },
    },
    ...(refusal.missing?.length
      ? [{
          id: "missing",
          component: "Text",
          source: "prewired" as const,
          props: { text: `Missing capability: ${refusal.missing.join(" · ")}`, variant: "caption" } as Record<string, Json>,
        }]
      : []),
  ];
  const document = finishDocument("Refused: the host can't ground this ask", nodes, []);
  return { document, queryCount: 0, nodeCount: nodes.length };
}
