// @vitest-environment jsdom
/**
 * Pane contract: the Spec pane frames the lane's COMPILED document in the
 * host's own document (/embed/<host>?run=<id>&lane=spec) — the same frame
 * boundary as the Vendo pane, because the render path IS the production
 * renderer; only the lane param differs. Non-ok states ride the shared
 * competitor-pane chrome, and the asymmetry footnote is permanent.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { VENDO_APP_FORMAT, VENDO_TREE_FORMAT, type AppDocument } from "@vendoai/core";
import SpecPane from "./SpecPane";
import type { LaneResult } from "../../runner/types";

const document_: AppDocument = {
  format: VENDO_APP_FORMAT,
  id: "app_bench_spec_test",
  name: "Clients overview",
  ui: "tree",
  tree: {
    formatVersion: VENDO_TREE_FORMAT,
    root: "app",
    nodes: [{ id: "app", component: "Stack", children: [] }],
  },
};

const okResult: LaneResult = { status: "ok", startedAt: 1, durationMs: 2, document: document_, findings: [] };

const frames = (container: HTMLElement) =>
  Array.from(container.querySelectorAll("iframe")).map((frame) => frame.getAttribute("src"));

afterEach(cleanup);

describe("SpecPane", () => {
  it("frames the compiled document in the host's document with lane=spec", () => {
    const { container } = render(
      <SpecPane lane="spec" result={okResult} runId="20260806-1200-abcd" host="maple" />,
    );
    expect(frames(container)).toEqual(["/embed/maple?run=20260806-1200-abcd&lane=spec"]);
  });

  it("frames the cadence host for a cadence run", () => {
    const { container } = render(
      <SpecPane lane="spec" result={okResult} runId="run_cadence" host="cadence" />,
    );
    expect(frames(container)).toEqual(["/embed/cadence?run=run_cadence&lane=spec"]);
  });

  it("shows the failure vocabulary for a failed result, with no frame", () => {
    const { container } = render(
      <SpecPane
        lane="spec"
        result={{ status: "failed", startedAt: 1, durationMs: 2, error: "every piece failed validation" }}
        runId="run_failed"
        host="maple"
      />,
    );
    expect(screen.getByText(/every piece failed validation/)).toBeTruthy();
    expect(frames(container)).toEqual([]);
  });

  it("shows the no-key state", () => {
    render(<SpecPane lane="spec" result={{ status: "no-key" }} runId="run_nokey" host="maple" />);
    expect(screen.getByText(/no key/)).toBeTruthy();
  });

  it("keeps the permanent asymmetry footnote", () => {
    render(<SpecPane lane="spec" result={okResult} runId="run_ok" host="maple" />);
    expect(screen.getByText(/one repair round/)).toBeTruthy();
  });
});
