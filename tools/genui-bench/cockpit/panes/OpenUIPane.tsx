"use client";
/**
 * OpenUI pane — renders the lane's openui-lang program with THEIR runtime
 * (@openuidev/react-lang `Renderer`) over VENDO's component kit
 * (vendo-kit-openui.tsx — captain decision: their language, our components;
 * stock openui components only as recorded fallbacks). The canvas carries the
 * host's real theme tokens (GET /api/theme), so the Kit renders brand-native
 * — the same variables /embed/<host> gives the vendo lane.
 *
 * Query()/Mutation() bindings and Button/Form host-tool actions resolve at
 * render time through POST `/api/tools` — the same canned fixture executors
 * every lane runs against.
 *
 * A REFUSED turn renders the PRESERVED program intact (when one exists) with
 * the typed refusal below it as a first-class Disclaimer-card program — the
 * openui-lane analog of the vendo runtime showing `ConductedRefusal.reasons`.
 */
import "@openuidev/react-ui/index.css";
import { useEffect, useMemo, useState } from "react";
import { Renderer } from "@openuidev/react-lang";
import { ThemeProvider } from "@openuidev/react-ui";
import { themeCssVariables } from "@vendoai/ui";
import type { ToolOutcome, VendoTheme } from "@vendoai/core";
import type { OpenUIRaw } from "../../lanes/openui";
import type { HostName } from "../../runner/types";
import type { PaneProps } from "../pane-props";
import { PaneFootnote, PaneNonOk } from "./pane-chrome";
import { KitToolRunnerContext, benchRenderLibrary, type KitToolRunner } from "./vendo-kit-openui";

const FOOTNOTE = "openui-lang · their parser + runtime · VENDO kit components · tools bound at render";

async function callTool(host: HostName, tool: string, input: Record<string, unknown>): Promise<unknown> {
  const response = await fetch("/api/tools", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ host, tool, input }),
  });
  const outcome = (await response.json()) as ToolOutcome;
  if (outcome.status === "ok") return outcome.output;
  if (outcome.status === "error") throw new Error(`${outcome.error.code}: ${outcome.error.message}`);
  // The canned fixtures never gate (no approvals/consent), so any other
  // outcome status is itself the surprise worth surfacing on the query.
  throw new Error(`tool outcome ${outcome.status}`);
}

/** Function-map toolProvider over the bench's tool transport. */
function toolProviderFor(
  host: HostName,
  tools: readonly string[],
): Record<string, (args: Record<string, unknown>) => Promise<unknown>> {
  return Object.fromEntries(
    tools.map((tool) => [tool, (args: Record<string, unknown>) => callTool(host, tool, args ?? {})]),
  );
}

/** The host's theme variables, fetched once per host. */
function useThemeVars(host: HostName): Record<string, string> {
  const [vars, setVars] = useState<Record<string, string>>({});
  useEffect(() => {
    let cancelled = false;
    void fetch(`/api/theme?host=${encodeURIComponent(host)}`)
      .then(async (response) => (response.ok ? ((await response.json()) as { theme: VendoTheme }).theme : null))
      .then((theme) => {
        if (!cancelled && theme !== null) setVars(themeCssVariables(theme));
      })
      .catch(() => {
        // Kit tokens carry fallbacks; an unthemed canvas still renders true.
      });
    return () => {
      cancelled = true;
    };
  }, [host]);
  return vars;
}

function ProgramRenderer({ host, program, tools }: { host: HostName; program: string; tools: readonly string[] }) {
  const toolProvider = useMemo(() => toolProviderFor(host, tools), [host, tools]);
  return (
    <Renderer
      response={program}
      // lang-core's Library<unknown> vs react-lang's Library<ComponentRenderer>:
      // the wrappers ARE React renderers; the parameter is erased at runtime.
      library={benchRenderLibrary as never}
      isStreaming={false}
      toolProvider={toolProvider}
    />
  );
}

export default function OpenUIPane({ result, host }: PaneProps) {
  const raw = result.status === "ok" || result.status === "refused" || result.status === "failed"
    ? (result.raw as OpenUIRaw | undefined)
    : undefined;
  const themeVars = useThemeVars(host);
  const runTool = useMemo<KitToolRunner>(() => (tool, input) => callTool(host, tool, input), [host]);

  const program = result.status === "failed" ? undefined : raw?.program;
  const refusal = result.status === "failed" ? undefined : raw?.refusal;

  return (
    <div data-pane="openui">
      {program !== undefined || refusal !== undefined ? (
        /* The host's own theme variables on a light canvas: the Kit reads
         * --vendo-* tokens (brand-native, same vars as /embed/<host>); the
         * stock-fallback components keep their light theme scoped here. */
        <div data-openui-canvas style={{ background: "#ffffff", borderRadius: 8, padding: 12, ...themeVars }}>
          <ThemeProvider mode="light" cssSelector="[data-openui-canvas]">
            <KitToolRunnerContext.Provider value={runTool}>
              {program !== undefined ? (
                <ProgramRenderer host={host} program={program} tools={raw?.toolsReferenced ?? []} />
              ) : null}
              {refusal !== undefined ? (
                <div data-openui-refusal style={program === undefined ? undefined : { marginTop: 12 }}>
                  <ProgramRenderer host={host} program={refusal.program} tools={[]} />
                </div>
              ) : null}
            </KitToolRunnerContext.Provider>
          </ThemeProvider>
        </div>
      ) : (
        <PaneNonOk result={result} />
      )}
      <PaneFootnote>
        {FOOTNOTE}
        {raw?.model ? ` · ${raw.model}` : ""}
        {raw !== undefined && raw.repairs > 0 ? ` · ${raw.repairs} repair${raw.repairs === 1 ? "" : "s"}` : ""}
      </PaneFootnote>
    </div>
  );
}
