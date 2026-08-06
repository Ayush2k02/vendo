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
 * a heading, consecutive tile pieces (Stat, Sparkline) grouped into a Grid,
 * block pieces full-width, a piece's actions as a Row of real Buttons under
 * it. A piece that failed validation after the repair round renders as an
 * honest in-app Callout naming its errors — per-piece failure, never a blank.
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
import type { SpecPiece, ViewSpec } from "./format";
import type { PieceVerdict } from "./validate";

/** `select` dot-path → the JSON Pointer under the piece's query result. */
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

function pieceNodes(piece: SpecPiece, entry: ChromeEntry, id: string, pool: QueryPool): TreeNode[] {
  const nodes: TreeNode[] = [];
  const actions = piece.actions ?? [];

  if (entry.dataSlot !== undefined && piece.tool !== undefined) {
    const query = queryFor(pool, piece.tool, piece.params);
    nodes.push({
      id,
      component: entry.use,
      source: "prewired",
      props: {
        ...(piece.props ?? {}),
        [entry.dataSlot.prop]: { $path: selectPointer(query, piece.select) },
      } as Record<string, Json>,
    });
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
    nodes.push(
      { id: `${id}-actions`, component: "Row", source: "prewired", props: { gap: 8 }, children: buttons.map((node) => node.id) },
      ...buttons,
    );
  }

  return nodes;
}

/** The honest render of a piece that failed validation after the one repair
 *  round: a real Callout naming the piece and its errors, in place. */
function failureNodes(verdict: PieceVerdict, id: string): TreeNode[] {
  return [
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
}

export interface CompiledSpec {
  document: AppDocument;
  queryCount: number;
  nodeCount: number;
}

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

  // Tile runs share a Grid row; everything else stacks. This loop is the
  // entire layout policy — the model never expressed any.
  let tileRun: TreeNode[] = [];
  const flushTiles = (): void => {
    if (tileRun.length === 0) return;
    const gridId = `grid-${rootChildren.length}`;
    nodes.push({
      id: gridId,
      component: "Grid",
      source: "prewired",
      props: { columns: Math.min(tileRun.length, 3), gap: 12 },
      children: tileRun.map((node) => node.id),
    });
    rootChildren.push(gridId);
    tileRun = [];
  };

  for (const verdict of verdicts) {
    const id = `piece-${verdict.index}`;
    if (verdict.errors.length > 0) {
      flushTiles();
      const failed = failureNodes(verdict, id);
      nodes.push(...failed);
      rootChildren.push(id);
      continue;
    }
    const piece = spec.components[verdict.index] as SpecPiece;
    const entry = chromeEntry(piece.use) as ChromeEntry;
    const compiled = pieceNodes(piece, entry, id, pool);
    nodes.push(...compiled);
    const tops = compiled.filter((node) => node.id === id || node.id === `${id}-actions`);
    if (entry.layout === "tile" && tops.length === 1 && tops[0]?.id === id) {
      tileRun.push(tops[0]);
    } else {
      flushTiles();
      rootChildren.push(...tops.map((node) => node.id));
    }
  }
  flushTiles();

  nodes.unshift({ id: "app", component: "Stack", source: "prewired", props: { gap: 16 }, children: rootChildren });

  const tree = {
    formatVersion: VENDO_TREE_FORMAT,
    root: "app",
    nodes,
    ...(pool.queries.length === 0 ? {} : { queries: pool.queries }),
  };
  const gate = validateTree(tree);
  if (!gate.ok) throw new Error(`spec compiler produced an invalid tree: ${gate.error.message}`);

  const document: AppDocument = {
    format: VENDO_APP_FORMAT,
    id: `app_bench_spec_${createHash("sha256").update(JSON.stringify(tree)).digest("hex").slice(0, 8)}`,
    name: spec.title,
    ui: "tree",
    tree,
  };
  return { document, queryCount: pool.queries.length, nodeCount: nodes.length };
}
