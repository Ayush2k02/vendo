/**
 * Shared chrome for competitor panes: the permanent asymmetry footnote
 * (spec: "every competitor pane permanently states its asymmetry so a weak
 * pane is never misread as a weak product") and the no-key/failed states.
 */
import type { LaneResult } from "../../runner/types";

export function PaneFootnote({ children }: { children: React.ReactNode }) {
  return (
    <p
      data-pane-footnote
      style={{
        margin: "10px 0 0",
        fontSize: 11,
        color: "#8b8b96",
        borderTop: "1px solid #26262e",
        paddingTop: 6,
      }}
    >
      {children}
    </p>
  );
}

/** Renders the non-ok states; returns null when the result is ok. */
export function PaneNonOk({ result }: { result: LaneResult }) {
  if (result.status === "no-key") {
    return (
      <p data-pane-state="no-key" style={{ color: "#8b8b96", fontSize: 13 }}>
        no key — set this lane&apos;s API key in the root .env
      </p>
    );
  }
  if (result.status === "refused") {
    return (
      <div data-pane-state="refused" style={{ fontSize: 13, color: "#d9b96a" }}>
        <p style={{ margin: "0 0 4px", fontWeight: 600 }}>the host refused this ask</p>
        <ul style={{ margin: 0, paddingLeft: 18 }}>
          {result.reasons.map((reason, index) => (
            <li key={index}>{reason}</li>
          ))}
        </ul>
      </div>
    );
  }
  if (result.status === "failed") {
    return (
      <div data-pane-state="failed" style={{ color: "#e0716f", fontSize: 13 }}>
        <p style={{ margin: 0 }}>failed: {result.error}</p>
        {result.raw !== undefined ? (
          <pre style={{ fontSize: 11, overflow: "auto", maxHeight: 200 }}>
            {JSON.stringify(result.raw, null, 2)}
          </pre>
        ) : null}
      </div>
    );
  }
  return null;
}
