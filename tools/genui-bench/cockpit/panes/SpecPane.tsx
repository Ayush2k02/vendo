"use client";
/**
 * Spec pane — frames the lane's COMPILED document in the same host document
 * the Vendo pane uses (`/embed/<host>?run=<id>&lane=spec`): VendoProvider
 * with the host's real theme, the production tree renderer, the real
 * Kit/prewired components, queries and actions live against /api/tools. The
 * lane's whole claim is "specs over free layout, rendered by the product's
 * own chrome", so the render path IS the product's — the only spec-lane code
 * between model output and pixels is the validator + the deterministic
 * spec→tree compiler (lanes/spec/).
 */
import type { LaneResult } from "../../runner/types";
import type { PaneProps } from "../pane-props";
import { PaneFootnote, PaneNonOk } from "./pane-chrome";

const FOOTNOTE =
  "native view-spec (JSON, zero layout) · refuses ungrounded asks · one repair round · compiled onto the production tree renderer";

const FRAME_STYLE: React.CSSProperties = {
  display: "block",
  width: "100%",
  height: "100%",
  minHeight: 320,
  border: 0,
  background: "transparent",
};

function hasDocument(result: LaneResult): boolean {
  return result.status === "ok" && result.document !== undefined;
}

export default function SpecPane({ result, host, runId }: PaneProps) {
  return (
    <div data-pane="spec" style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      {hasDocument(result) ? (
        <iframe
          data-spec-host-frame={host}
          title="Spec — compiled view"
          src={`/embed/${host}?run=${encodeURIComponent(runId)}&lane=spec`}
          style={FRAME_STYLE}
        />
      ) : (
        <PaneNonOk result={result} />
      )}
      <PaneFootnote>{FOOTNOTE}</PaneFootnote>
    </div>
  );
}
