/**
 * GET /api/theme?host=<maple|cadence> — the host fixture's real theme
 * (.vendo/theme.json, schema-parsed), so the OpenUI pane can stamp vendo's
 * CSS variables onto its canvas and the Kit renders brand-native there, the
 * same tokens /embed/<host> gives the vendo lane.
 */
import { fixtures } from "../../../fixtures";
import type { HostName } from "../../../runner/types";

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const host = url.searchParams.get("host");
  const fixture = host === null ? undefined : fixtures[host as HostName];
  if (fixture === undefined) {
    return Response.json({ error: `unknown host "${String(host)}" (maple|cadence)` }, { status: 400 });
  }
  return Response.json({ theme: fixture.theme });
}
