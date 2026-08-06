/**
 * Vendo's guardrails, ported onto openui-lang generation. Three of the vendo
 * engine's behaviors, re-expressed against THEIR language and THEIR parser:
 *
 * 1. GROUNDING + TYPED REFUSAL (brain.ts `<Cannot>` protocol). The stock
 *    openui prompt says "use realistic mock data instead of fabricating a
 *    tool call" and "generate realistic/plausible data" — exactly the
 *    fabrication the prior bench caught (confident fake balances at an
 *    accounting firm). The grounding contract OVERRIDES those lines with the
 *    vendo brain's honesty rule: when no cataloged tool can supply what the
 *    person asks for, the answer is one `<Cannot>` line per thing out of
 *    reach, in the person's own words — never a program over mock data,
 *    never a loosely-related tool bound to look like an answer.
 *
 * 2. FACT VALIDATION (checking/facts.ts). Every Query/Mutation binding is
 *    checked against the host catalog (`unknownToolIssues` teaching message:
 *    the finding LISTS the real tools) and every element against the library
 *    schema (their parser's own ValidationErrors, enriched with their hints).
 *    A fact is a `block`; render-time surprises are the class this kills.
 *
 * 3. BOUNDED REPAIR (conductor.ts checkAndFix). Blocking findings go BACK to
 *    the model as a teaching instruction, at most {@link FIX_ROUNDS} times —
 *    same constant, same rationale: being shown exactly what is wrong fixes
 *    it on the first or second try or not at all. What survives is an honest
 *    `failed`, never a silently broken render.
 *
 * Pure module: no model calls, no I/O — the lane wires it to generation.
 */
import {
  createParser,
  enrichErrors,
  type ElementNode,
  type LibraryJSONSchema,
  type ParseResult,
} from "@openuidev/lang-core";
import type { Finding } from "@vendoai/apps";
import type { SessionSnapshot } from "../runner/types";

/** Same bound as the vendo conductor's fix-it loop (conductor.ts FIX_ROUNDS). */
export const FIX_ROUNDS = 2;

const CANNOT_LINE = /<Cannot>([\s\S]*?)<\/Cannot>/g;

/** The `<Cannot>` reasons in an answer (brain.ts protocol, verbatim port). */
export function readCannot(text: string): string[] {
  return [...text.matchAll(CANNOT_LINE)]
    .map(([, reason]) => (reason ?? "").trim())
    .filter((reason) => reason.length > 0);
}

/** The answer with its `<Cannot>` lines removed — what may still be program
 *  text (a partial refusal patches the groundable part and refuses the rest). */
export function stripCannot(text: string): string {
  return text.replace(CANNOT_LINE, "").trim();
}

/**
 * The honesty rules appended AFTER the generated library prompt, so they
 * override its mock-data instructions ("use realistic mock data", "generate
 * realistic/plausible data"). Sentences ported from the vendo brain prompt.
 */
export function groundingContract(mode: "create" | "edit"): string {
  const shared = `## Grounding contract (OVERRIDES every earlier rule about mock, realistic, or plausible data)

- Never invent data. Every number, row, and label a component shows comes from a Query() against a tool listed above. Mock data is a lie about this host — the earlier "use realistic mock data" rule does NOT apply.
- THE HOST CANNOT DO IT — when no listed tool can supply what the person asks for, do not write a program. Say so instead: one <Cannot> line per thing that is out of reach, in the person's own words, e.g. <Cannot>Your host has no revenue data, so profitability cannot be computed.</Cannot> — and nothing else. An honest refusal always beats a plausible fake.
- Do not bind a loosely-related tool to make an answer look grounded (a client list is not accounts receivable; a document checklist is not a ledger). If the mapping from the ask to a tool's real output is not honest, refuse.
- Static text (titles, labels, options) is fine; static "data" (numbers, rows, series) is not.`;
  if (mode === "create") return shared;
  return `${shared}
- When an EDIT asks for something out of reach, refuse ONLY that addition: answer with <Cannot> lines for it and output no patch statements for it. Statements you do not output are kept as they are, so the existing UI stays intact. If part of the ask is groundable, patch that part and refuse the rest.`;
}

/** What the model is told to fix (conductor.ts fixInstruction port): the
 *  findings themselves, nothing translated. */
export function fixInstruction(findings: readonly Finding[]): string {
  return [
    "These things are wrong with the program as it stands. Fix each one with patch statements (merge semantics: output ONLY the statements that change — everything else is kept), and change nothing else.",
    ...findings.map(({ where, message }) => (where === undefined ? `- ${message}` : `- ${where}: ${message}`)),
    "If a finding cannot be fixed because no listed tool can supply the data, answer with <Cannot> lines instead of a patch.",
  ].join("\n");
}

/** The full-rewrite retry instruction (brain.ts retry feedback port), for a
 *  response that produced nothing patchable. */
export function rewriteInstruction(issues: readonly string[]): string {
  return [
    "YOUR LAST ANSWER DID NOT WORK. WHAT WAS WRONG WITH IT:",
    ...issues.map((issue) => `- ${issue}`),
    "Write the whole program again, fixed — or refuse with <Cannot> lines if the ask is out of reach.",
  ].join("\n");
}

const escapeString = (text: string): string => text.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

/**
 * The refusal as a first-class openui-lang program over VENDO's kit: one
 * Disclaimer per reason — the Kit's own "no tool backs this" component —
 * rendered by their runtime; the openui-lane analog of the vendo runtime
 * showing `ConductedRefusal.reasons`.
 */
export function refusalProgram(reasons: readonly string[]): string {
  const cards = reasons.map((reason, index) =>
    `cannot${index + 1} = Disclaimer("${escapeString(reason)}", "Out of reach")`);
  return [
    `root = Stack([title, ${reasons.map((_, index) => `cannot${index + 1}`).join(", ")}], 10)`,
    `title = Text("This host cannot do that", "heading")`,
    ...cards,
  ].join("\n");
}

export interface ProgramValidation {
  parsed: ParseResult;
  /** Vendo findings vocabulary (severity · where · message); `block` = a fact
   *  is wrong and the program must not render as-is. */
  findings: Finding[];
  /** True when there is nothing patchable (no statements survived parsing) —
   *  repair must rewrite whole rather than patch. */
  unpatchable: boolean;
}

/** Tool names the program binds (string-literal Query/Mutation targets). */
export function boundTools(parsed: ParseResult): string[] {
  return [...parsed.queryStatements, ...parsed.mutationStatements]
    .map((statement) => statement.toolAST)
    .filter((ast): ast is { k: "Str"; v: string } => ast?.k === "Str" && typeof (ast as { v?: unknown }).v === "string")
    .map((ast) => ast.v);
}

/**
 * Every fact about the program that can be decided by looking things up
 * (facts.ts pattern): elements against the library schema (their parser's own
 * errors, with their hints), bindings against the host catalog (the teaching
 * message lists the real tools), references against the statement list.
 */
export function validateProgram(
  program: string,
  hostTools: readonly string[],
  librarySchema: LibraryJSONSchema,
  componentNames: readonly string[],
  stockFallbackNames: readonly string[] = [],
): ProgramValidation {
  const parsed = createParser(librarySchema).parse(program);
  const findings: Finding[] = [];

  // Stock-fallback usage is legal but RECORDED (captain rule: vendo's
  // components are the library; the stock set is a fallback, never silent).
  if (stockFallbackNames.length > 0) {
    const stock = new Set(stockFallbackNames);
    for (const [statement, component] of Object.entries(programSnapshot(parsed).components)) {
      if (stock.has(component)) {
        findings.push({
          severity: "warn",
          where: `statement "${statement}"`,
          message: `renders with the stock openui component "${component}" — the vendo kit has no equivalent (recorded fallback)`,
        });
      }
    }
  }

  for (const error of enrichErrors(parsed.meta.errors, librarySchema, [...componentNames])) {
    findings.push({
      severity: "block",
      where: error.statementId === undefined ? `component "${error.component ?? "?"}"` : `statement "${error.statementId}"`,
      message: `${error.message}${error.hint === undefined ? "" : ` — ${error.hint}`}`,
    });
  }

  const known = new Set(hostTools);
  for (const tool of [...new Set(boundTools(parsed))]) {
    if (!known.has(tool)) {
      findings.push({
        severity: "block",
        where: `tool "${tool}"`,
        message: `the program binds "${tool}", which this host does not expose; the host tools are: ${[...known].join(", ")}`,
      });
    }
  }

  for (const name of parsed.meta.unresolved) {
    findings.push({
      severity: "block",
      where: `reference "${name}"`,
      message: "is used but never defined, so it renders as nothing — define it, or remove the reference",
    });
  }
  for (const name of parsed.meta.orphaned) {
    findings.push({
      severity: "warn",
      where: `statement "${name}"`,
      message: "is defined but not reachable from root, so it will not render — reference it from root (or a parent), or delete it",
    });
  }

  if (parsed.meta.incomplete) {
    findings.push({ severity: "block", where: "program", message: "is incomplete (truncated output) — write it again whole" });
  }
  if (parsed.root === null) {
    findings.push({ severity: "block", where: "program", message: "has no renderable root statement — define root as the entry point" });
  }

  return { parsed, findings, unpatchable: parsed.meta.statementCount === 0 };
}

/** Walk an ElementNode tree collecting every statement-backed element. */
const collectElements = (node: unknown, into: Map<string, string>): void => {
  if (Array.isArray(node)) {
    for (const item of node) collectElements(item, into);
    return;
  }
  if (typeof node !== "object" || node === null) return;
  const element = node as Partial<ElementNode>;
  if (element.type === "element" && typeof element.typeName === "string") {
    if (typeof element.statementId === "string") into.set(element.statementId, element.typeName);
    collectElements(Object.values(element.props ?? {}), into);
    return;
  }
  collectElements(Object.values(node as Record<string, unknown>), into);
};

/**
 * The program as a lane-neutral snapshot for conversation scoring: statement
 * ids as stable element identity (their merge semantics: same name = same
 * element), component type per statement. Query/Mutation statements ride
 * along so a lost data binding counts as a lost element too.
 */
export function programSnapshot(parsed: ParseResult): SessionSnapshot {
  const components = new Map<string, string>();
  collectElements(parsed.root, components);
  for (const query of parsed.queryStatements) components.set(query.statementId, "Query");
  for (const mutation of parsed.mutationStatements) components.set(mutation.statementId, "Mutation");
  return {
    elements: [...components.keys()].sort(),
    components: Object.fromEntries(components),
  };
}
