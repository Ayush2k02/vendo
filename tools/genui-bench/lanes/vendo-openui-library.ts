/**
 * VENDO's component kit registered as the openui-lang library (captain
 * decision: the lane speaks THEIR language — parser, merge semantics,
 * Renderer — but renders over OUR components). Every entry mirrors a
 * `KIT_SPECS` component from @vendoai/core: same name, same props, same
 * required flags, same docs — the prompt signatures lang-core derives from
 * these schemas are therefore derived from the Kit's own spec surface (a
 * drift test pins this file to KIT_SPECS). Container components additionally
 * take `children`, because openui-lang expresses containment as a prop where
 * the vendo wire nests structurally.
 *
 * Vendo semantics survive the translation deliberately:
 *   - Money/Stat format "money" take integer CENTS (law: never dollars);
 *   - charts take ROWS + key names (xKey/series/categoryKey), never parallel
 *     label/value arrays;
 *   - Button.onClick / Form.onSubmit NAME a host tool (action-gated — the
 *     pane routes clicks through the same /api/tools pipe queries use);
 *   - Disclaimer is the in-app honesty move when one part of an otherwise
 *     groundable ask has no tool behind it.
 *
 * STOCK FALLBACK: the few @openuidev/react-ui components with no Kit
 * equivalent stay available under their own names ({@link STOCK_FALLBACK_NAMES}).
 * Using one is legal but RECORDED — validation attaches a warn finding per
 * fallback statement, so a render that leaned on the stock library is never
 * mistaken for a pure-Kit render.
 *
 * This module is headless (no React imports): the lane uses it for prompt
 * generation and validation; the cockpit pane injects the real React
 * implementations via {@link buildBenchLibrary}.
 */
// zod/v4: lang-core's defineComponent asserts a Zod 4 schema (zod@3.25+
// ships the v4 API under this subpath — same package, different dialect).
import { z } from "zod/v4";
import { createLibrary, defineComponent, type DefinedComponent, type Library, type PromptOptions } from "@openuidev/lang-core";
import { openuiLibrary } from "@openuidev/react-ui";

const rows = z.array(z.record(z.string(), z.unknown()));
const valueFormat = z.enum(["money", "date", "datetime", "time", "percent", "number", "text"]);
const seriesInput = z.array(z.union([z.string(), z.object({ key: z.string(), label: z.string().optional() })]));
const tableColumn = z.object({
  key: z.string(),
  label: z.string().optional(),
  format: valueFormat.optional(),
  align: z.enum(["start", "center", "end"]).optional(),
});
const cardField = z.object({ key: z.string(), label: z.string().optional(), format: valueFormat.optional() });
const hostTool = z.string().describe("names a host tool");
const children = z.array(z.any()).describe("child components");

/** One vendo-kit component's schema surface. Order = positional-arg order. */
interface KitEntry {
  name: string;
  description: string;
  props: z.ZodObject<z.ZodRawShape>;
}

const KIT_ENTRIES: KitEntry[] = [
  // Layout
  { name: "Stack", description: "Vertical flow of children. The default container for a section (and the root).",
    props: z.object({ children, gap: z.number().optional().describe("pixels between children") }) },
  { name: "Row", description: "Horizontal flow; wraps by default. Use for a row of stats or buttons.",
    props: z.object({
      children,
      gap: z.number().optional().describe("pixels between children"),
      align: z.enum(["start", "center", "end", "stretch"]).optional().describe("cross-axis alignment"),
      justify: z.enum(["start", "center", "end", "between"]).optional().describe("main-axis distribution"),
    }) },
  { name: "Grid", description: "Equal-width columns. Use for a grid of cards or stats.",
    props: z.object({ children, columns: z.number().optional().describe("column count"), gap: z.number().optional().describe("pixels between cells") }) },
  { name: "Surface", description: "A bordered, elevated container with an optional title.",
    props: z.object({ children, title: z.string().optional().describe("container heading") }) },
  { name: "Divider", description: "A horizontal rule between blocks.", props: z.object({}) },

  // Values (money takes CENTS; dates take ISO/epoch)
  { name: "Text", description: "Themed text. Use variant \"heading\" for section titles.",
    props: z.object({ text: z.string().describe("the text to show"), variant: z.enum(["body", "heading", "caption", "label"]).optional().describe("text role") }) },
  { name: "Money", description: "Currency from an integer number of CENTS. Never pass dollars.",
    props: z.object({ cents: z.number().describe("amount in integer cents (minor units)"), currency: z.string().optional().describe("ISO 4217 code, default USD") }) },
  { name: "DateTime", description: "A date/time from an ISO string or epoch millis. Invalid input renders a dash.",
    props: z.object({ value: z.union([z.string(), z.number()]).describe("ISO string or epoch millis"), mode: z.enum(["date", "time", "datetime", "relative"]).optional().describe("how to render") }) },
  { name: "Percent", description: "A percentage from a ratio (0.42 → 42%). Pass whole=true for an already-whole percent.",
    props: z.object({ value: z.number().describe("a ratio 0..1"), fractionDigits: z.number().optional().describe("decimal places"), whole: z.boolean().optional().describe("value is already a whole percent") }) },
  { name: "Num", description: "A grouped number. Use notation \"compact\" for large counts (1.5M).",
    props: z.object({ value: z.number().describe("the number"), notation: z.enum(["standard", "compact"]).optional().describe("grouping style"), maximumFractionDigits: z.number().optional().describe("decimal places") }) },
  { name: "EnumBadge", description: "A status pill for an enum field. Humanizes the raw value (past_due → Past due) and tone-maps it.",
    props: z.object({
      value: z.string().nullable().describe("the raw enum value"),
      labels: z.record(z.string(), z.string()).optional().describe("value → display label overrides"),
      tones: z.record(z.string(), z.enum(["neutral", "accent", "success", "warning", "danger"])).optional().describe("value → tone overrides"),
    }) },

  // Data
  { name: "DataTable", description: "The smart table. Sorts, filters, searches, paginates, resolves dot-path column keys, and formats each cell — you only pass rows and columns.",
    props: z.object({
      rows: rows.describe("rows from a tool call"),
      columns: z.array(tableColumn).optional().describe("column descriptions; key supports dot-paths like client.name; format is a value tier token"),
      sortBy: z.string().optional().describe('initial sort, e.g. "dueDate asc"'),
      limit: z.number().optional().describe("hard cap on rows shown"),
      filterableBy: z.array(z.string()).optional().describe("column keys to expose as filter dropdowns"),
      searchable: z.boolean().optional().describe("show a search box across all columns"),
      paginate: z.number().optional().describe("page size (enables pagination)"),
      emptyState: z.string().optional().describe("text when the query returns no rows"),
      caption: z.string().optional().describe("table caption"),
    }) },
  { name: "CardList", description: "One branded card per record. Use when rows read better as cards than a table.",
    props: z.object({
      items: rows.describe("items from a tool call"),
      titleField: z.string().optional().describe("field for each card title"),
      badgeField: z.string().optional().describe("field rendered as a status pill"),
      fields: z.array(cardField).optional().describe("label/value rows shown on each card"),
      columns: z.number().optional().describe("cards per row"),
      emptyState: z.string().optional().describe("text when there are no items"),
    }) },
  { name: "Stat", description: "A KPI/metric summary. Formats its value (money takes cents) and shows an optional trend.",
    props: z.object({
      label: z.string().describe("metric name"),
      value: z.union([z.number(), z.string()]).describe("raw value"),
      format: valueFormat.optional().describe("value tier format"),
      trend: z.string().optional().describe("delta caption, e.g. +12% MoM"),
      tone: z.enum(["default", "accent", "danger"]).optional().describe("emphasis"),
    }) },
  { name: "Badge", description: "A small literal status label the model writes. For enum data fields use EnumBadge instead.",
    props: z.object({ label: z.string().describe("badge text"), tone: z.enum(["neutral", "accent", "success", "warning", "danger"]).optional().describe("color tone") }) },

  // Charts (rows + key names; $NaN is unrenderable)
  { name: "LineChart", description: "A line/trend chart. Y-axis ticks and tooltips are formatted by the format token.",
    props: z.object({
      data: rows.describe("rows to plot"),
      xKey: z.string().describe("category (x) field"),
      series: seriesInput.describe("value series (keys or {key,label})"),
      format: valueFormat.optional().describe("y-axis + tooltip format"),
      height: z.number().optional().describe("chart height in px"),
      emptyState: z.string().optional().describe("text when there is nothing to plot"),
    }) },
  { name: "BarChart", description: "A bar chart. Set horizontal for ranked lists, stacked to combine series.",
    props: z.object({
      data: rows.describe("rows to plot"),
      xKey: z.string().describe("category field"),
      series: seriesInput.describe("value series"),
      format: valueFormat.optional().describe("axis + tooltip format"),
      stacked: z.boolean().optional().describe("stack series into one bar"),
      horizontal: z.boolean().optional().describe("horizontal bars"),
      height: z.number().optional().describe("chart height in px"),
      emptyState: z.string().optional().describe("text when there is nothing to plot"),
    }) },
  { name: "DonutChart", description: "A donut/pie of category shares. Zero and invalid slices are dropped.",
    props: z.object({
      data: rows.describe("rows to plot"),
      categoryKey: z.string().describe("slice-label field"),
      valueKey: z.string().describe("slice-value field"),
      format: valueFormat.optional().describe("tooltip format"),
      donut: z.boolean().optional().describe("false renders a full pie"),
      height: z.number().optional().describe("chart height in px"),
      emptyState: z.string().optional().describe("text when there is nothing to plot"),
    }) },
  { name: "Sparkline", description: "A compact inline trend. Pass a number list or rows with a valueKey.",
    props: z.object({
      data: z.array(z.union([z.number(), z.record(z.string(), z.unknown())])).describe("numbers or rows"),
      valueKey: z.string().optional().describe("field to read when data holds objects"),
      height: z.number().optional().describe("height in px"),
    }) },
  { name: "Progress", description: "A progress bar from a ratio (0..1) or value/max. Clamps to 100%.",
    props: z.object({
      value: z.number().describe("ratio 0..1, or a raw value with max"),
      max: z.number().optional().describe("denominator when value is raw"),
      label: z.string().optional().describe("caption"),
      showValue: z.boolean().optional().describe("show the percentage"),
      tone: z.enum(["accent", "success", "danger"]).optional().describe("fill color"),
    }) },

  // Forms (onChange/onClick/onSubmit NAME a host tool — action-gated)
  { name: "Input", description: "A text field. onChange names a host tool.",
    props: z.object({
      label: z.string().optional().describe("field label"),
      value: z.string().optional().describe("initial value"),
      placeholder: z.string().optional().describe("placeholder text"),
      type: z.enum(["text", "email", "number", "password", "search", "tel", "url"]).optional().describe("input type"),
      onChange: hostTool.optional(),
    }) },
  { name: "Select", description: "A dropdown over a RAW array of tool output. Map objects with labelField/valueField — no reshaping.",
    props: z.object({
      options: z.array(z.union([z.string(), z.number(), z.record(z.string(), z.unknown())])).describe("raw items"),
      label: z.string().optional().describe("field label"),
      labelField: z.string().optional().describe("object field for the visible label"),
      valueField: z.string().optional().describe("object field for the value"),
      placeholder: z.string().optional().describe("empty-choice text"),
      multiple: z.boolean().optional().describe("allow several values"),
      onChange: hostTool.optional(),
    }) },
  { name: "DatePicker", description: "A native date control (ISO yyyy-mm-dd).",
    props: z.object({
      label: z.string().optional().describe("field label"),
      value: z.string().optional().describe("ISO date"),
      min: z.string().optional().describe("earliest date"),
      max: z.string().optional().describe("latest date"),
      onChange: hostTool.optional(),
    }) },
  { name: "Textarea", description: "A multiline text field.",
    props: z.object({
      label: z.string().optional().describe("field label"),
      value: z.string().optional().describe("initial value"),
      placeholder: z.string().optional().describe("placeholder text"),
      rows: z.number().optional().describe("visible rows"),
      onChange: hostTool.optional(),
    }) },
  { name: "Checkbox", description: "A boolean toggle. onChange receives the checked state.",
    props: z.object({
      label: z.string().optional().describe("field label"),
      checked: z.boolean().optional().describe("initial checked state"),
      onChange: hostTool.optional(),
    }) },
  { name: "Button", description: "Action-gated button. onClick NAMES a host tool; the runtime routes it through the guarded pipe. This is the only way the UI mutates.",
    props: z.object({
      label: z.string().describe("button text"),
      onClick: hostTool.optional().describe("the host tool to run"),
      variant: z.enum(["primary", "secondary", "danger"]).optional().describe("emphasis"),
      disabled: z.boolean().optional().describe("disabled state"),
    }) },
  { name: "Form", description: "Groups fields with a submit action. onSubmit names a host tool.",
    props: z.object({
      children,
      onSubmit: hostTool.optional().describe("the host tool to run on submit"),
      submitLabel: z.string().optional().describe("submit button text"),
    }) },
  { name: "Disclaimer", description: "The legal move when NO tool backs one part of the ask. State plainly why the data can't be shown — never invent it.",
    props: z.object({
      reason: z.string().describe("why the ask can't be fulfilled with real data"),
      title: z.string().optional().describe("optional heading"),
    }) },

  // Feedback / interactive
  { name: "Tabs", description: "Self-managing tabs. Give each tab a label and content; switching needs no handler.",
    props: z.object({
      tabs: z.array(z.object({ label: z.string(), content: z.any(), disabled: z.boolean().optional() })).describe("tab definitions; content is a component or array of components"),
      defaultIndex: z.number().optional().describe("initially selected tab"),
    }) },
  { name: "Callout", description: "A toned notice highlighting real information. For 'no tool' honesty use Disclaimer.",
    props: z.object({
      body: z.string().describe("notice text"),
      tone: z.enum(["info", "accent", "success", "warning", "danger"]).optional().describe("notice tone"),
      title: z.string().optional().describe("notice heading"),
    }) },
  { name: "Accordion", description: "Self-managing collapsible sections. Good for long apps.",
    props: z.object({
      items: z.array(z.object({ label: z.string(), content: z.any() })).describe("sections; content is a component or array of components"),
      multiple: z.boolean().optional().describe("allow several open at once"),
    }) },
];

export const VENDO_KIT_COMPONENT_NAMES: readonly string[] = KIT_ENTRIES.map(({ name }) => name);

/** Stock @openuidev/react-ui components kept available because the Kit has no
 *  equivalent. Using one is RECORDED (a warn finding per statement). */
export const STOCK_FALLBACK_NAMES: readonly string[] = ["MarkDownRenderer", "Steps", "StepsItem"];

/** Their DefinedComponent objects, reused wholesale (schema + renderer). */
const stockFallbacks = (): DefinedComponent[] =>
  STOCK_FALLBACK_NAMES.flatMap((name) => {
    const component = openuiLibrary.components[name];
    return component === undefined ? [] : [component as DefinedComponent];
  });

/**
 * The bench library: vendo's kit (+ recorded stock fallbacks) under openui's
 * runtime. `impl` maps component name → React renderer; the headless callers
 * (prompt generation, validation) pass nothing and get render-less entries.
 */
export function buildBenchLibrary(impl: Readonly<Record<string, unknown>> = {}): Library {
  return createLibrary({
    id: "vendo-kit",
    root: "Stack",
    components: [
      ...KIT_ENTRIES.map(({ name, description, props }) => defineComponent({
        name,
        description,
        props: props as never,
        component: (impl[name] ?? null) as never,
      })),
      ...stockFallbacks(),
    ],
    componentGroups: [
      { name: "Layout", components: ["Stack", "Row", "Grid", "Surface", "Divider"] },
      { name: "Values", components: ["Text", "Money", "DateTime", "Percent", "Num", "EnumBadge"],
        notes: ["Money and format \"money\" take integer CENTS — never dollars."] },
      { name: "Data", components: ["DataTable", "CardList", "Stat", "Badge"] },
      { name: "Charts", components: ["LineChart", "BarChart", "DonutChart", "Sparkline", "Progress"],
        notes: ["Charts take ROWS plus key names (xKey/series/categoryKey/valueKey) — never parallel label/value arrays."] },
      { name: "Forms", components: ["Input", "Select", "DatePicker", "Textarea", "Checkbox", "Button", "Form", "Disclaimer"],
        notes: ["Button onClick and Form onSubmit NAME a host tool from the tools list — the host's action pipe runs it."] },
      { name: "Feedback", components: ["Tabs", "Callout", "Accordion"] },
      { name: "Stock openui fallbacks (no Kit equivalent; usage is recorded)", components: [...STOCK_FALLBACK_NAMES] },
    ],
  });
}

/** The headless library the lane prompts and validates with. */
export const benchLibrary: Library = buildBenchLibrary();
export const benchLibrarySchema = benchLibrary.toJSONSchema();
export const benchComponentNames: readonly string[] = Object.keys(benchLibrary.components);

/** Prompt options in the vendo-kit dialect (their PromptOptions surface —
 *  examples and rules re-authored for OUR components; their generic language
 *  rules ride the generated prompt unchanged). */
export const benchPromptOptions: PromptOptions = {
  preamble: "You generate UI over the HOST's own component kit (the signatures below are the host's real components) using openui-lang. The host's brand, formatting, and action-gating come from these components — use them as documented.",
  examples: [
    [
      'root = Stack([title, kpis, tbl], 14)',
      'title = Text("Overdue invoices", "heading")',
      'kpis = Row([totalStat, countStat], 12)',
      'totalStat = Stat("Total overdue", 1284500, "money", "+12% MoM")',
      'countStat = Stat("Invoices", 17, "number")',
      'tbl = DataTable(rowsData, [{key: "client.name", label: "Client"}, {key: "amountCents", format: "money", align: "end"}, {key: "dueDate", format: "date"}], "dueDate asc")',
      'rowsData = [{client: {name: "Acme"}, amountCents: 129900, dueDate: "2026-07-01"}]',
    ].join("\n"),
  ],
  toolExamples: [
    [
      'root = Stack([title, chart, tbl], 14)',
      'title = Text("Spending by category", "heading")',
      'txns = Query("host_listTransactions", { limit: 100 }, [])',
      'chart = DonutChart(txns, "category", "amountCents", "money")',
      'tbl = DataTable(txns, [{key: "merchant"}, {key: "amountCents", format: "money", align: "end"}, {key: "postedAt", format: "date"}], "postedAt desc", 20)',
    ].join("\n"),
    [
      'root = Stack([title, form], 14)',
      'title = Text("Send a reminder", "heading")',
      'form = Form([noteField, sendBtn], "host_sendClientMessage", "Send")',
      'noteField = Textarea("Message", null, "What should we say?", 4)',
      'sendBtn = Button("Send reminder", "host_sendClientMessage", "primary")',
    ].join("\n"),
  ],
  additionalRules: [
    "Money values are integer CENTS everywhere (Money.cents, Stat format \"money\", chart format \"money\") — never dollars.",
    "Charts take rows + key names: LineChart/BarChart(data, xKey, series), DonutChart(data, categoryKey, valueKey). Do NOT build parallel label/value arrays.",
    "DataTable does its own sorting/filtering/searching — pass rows and column descriptions, do not pre-sort with @Sort unless the ask needs a derived list.",
    "Button.onClick, Form.onSubmit, and every onChange NAME a host tool (a plain string from the tools list). Do not put Action([...]) expressions in those slots.",
    "When one PART of a groundable ask has no tool behind it, render the rest and add a Disclaimer(reason) for the missing part — never invent the number.",
  ],
};
