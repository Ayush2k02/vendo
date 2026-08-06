import type { AppDocument } from "@vendoai/core";
import { loadRun } from "../../runner/store";
import { isSafeName, runsDir } from "../api/paths";

/** A lane's document for one run id, read straight off disk (the embed page
 *  is a server component, so it needs no API hop). Only the two lanes that
 *  produce a renderable AppDocument are frameable: vendo (the default) and
 *  spec (the compiled view spec). `null` = unknown or malformed id, an
 *  unframeable lane, or a lane that produced no document. */
export function embedDocument(runId: string | undefined, lane?: string): AppDocument | null {
  if (runId === undefined || runId === "" || !isSafeName(runId)) return null;
  const laneName = lane === undefined || lane === "" ? "vendo" : lane;
  if (laneName !== "vendo" && laneName !== "spec") return null;
  try {
    const result = loadRun(runsDir, runId).lanes[laneName];
    return result?.status === "ok" ? (result.document ?? null) : null;
  } catch {
    return null;
  }
}

/** Every embed page takes the same query string: which run, which
 *  document-producing lane (default vendo), and whether the view is the
 *  read-only half of a split-compare. */
export interface EmbedSearchParams {
  run?: string;
  mode?: string;
  lane?: string;
}
