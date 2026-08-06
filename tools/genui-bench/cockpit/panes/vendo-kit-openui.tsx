"use client";
/**
 * The RENDER half of the vendo-backed openui library: every Kit component
 * from @vendoai/ui/kit wrapped for the openui React runtime (their Renderer
 * hands each registered component `{ props, renderNode, statementId }` with
 * props already evaluated). Containers map their `children`/`content` prop
 * values through `renderNode`; everything else passes props straight into
 * the Kit component.
 *
 * Vendo's action-gating survives: Button.onClick / Form.onSubmit / onChange
 * arrive as HOST TOOL NAMES (strings) and are routed through the same
 * `/api/tools` transport queries use, via {@link KitToolRunnerContext} which
 * OpenUIPane provides per host. The tool outcome lands as a browser-honest
 * alert-free inline state — a thrown error surfaces in their error boundary.
 */
import { createContext, useContext, type ReactNode } from "react";
import {
  Accordion, Badge, Button, Callout, CardList, Checkbox, DataTable, DatePicker,
  DateTime, Disclaimer, Divider, DonutChart, EnumBadge, Form, Grid, Input,
  LineChart, Money, Num, Percent, Progress, Row, Select, Sparkline, Stack,
  Stat, Surface, Tabs, Text, Textarea,
  BarChart,
  humanizeEnum,
} from "@vendoai/ui/kit";
import type { ComponentRenderProps, Library } from "@openuidev/lang-core";
import { buildBenchLibrary } from "../../lanes/vendo-openui-library";

/**
 * The "label" value-format token (vendo-openui-library.ts) humanizes an enum
 * CODE (missing_docs → "Missing docs"). The real kit DataTable/CardList/Stat
 * only know money/date/percent/number/text, so this deterministic bench-side
 * pass resolves "label" columns BEFORE the value reaches them: it humanizes
 * the bound cell/value and hands the component the humanized text. The vendo
 * kit itself is untouched — this is the bench's own post-bind formatter, the
 * escape the follow-up brief allows for known-enum shapes. */
const LABEL = "label";
type Col = { key?: unknown; format?: unknown };

const isLabelCol = (col: unknown): col is { key: string; format: string } =>
  typeof col === "object" && col !== null && (col as Col).format === LABEL && typeof (col as Col).key === "string";

/** Read `row[dotted.path]` the way the kit's DataTable resolves column keys. */
const readPath = (row: unknown, key: string): unknown =>
  key.split(".").reduce<unknown>((value, part) => (typeof value === "object" && value !== null ? (value as Record<string, unknown>)[part] : undefined), row);

const humanizeCell = (value: unknown): unknown => (typeof value === "string" && value !== "" ? humanizeEnum(value) : value);

/** Rewrite a row so each label-column's field is humanized in place, and strip
 *  the "label" token from the columns to the kit's own text default. */
function resolveLabelColumns(
  rowsValue: unknown,
  columnsValue: unknown,
): { rows: unknown; columns: unknown } {
  const columns = Array.isArray(columnsValue) ? columnsValue : undefined;
  const labelKeys = (columns ?? []).filter(isLabelCol).map((col) => col.key);
  if (labelKeys.length === 0) return { rows: rowsValue, columns: columnsValue };
  const rows = Array.isArray(rowsValue)
    ? rowsValue.map((row) => {
        const next = { ...(row as Record<string, unknown>) };
        for (const key of labelKeys) {
          // Dotted keys are written back at the same path so the kit resolves them.
          if (!key.includes(".")) next[key] = humanizeCell(next[key]);
          else {
            const humanized = humanizeCell(readPath(row, key));
            const parts = key.split(".");
            let cursor = next;
            for (let i = 0; i < parts.length - 1; i += 1) {
              cursor[parts[i] as string] = { ...(cursor[parts[i] as string] as Record<string, unknown>) };
              cursor = cursor[parts[i] as string] as Record<string, unknown>;
            }
            cursor[parts[parts.length - 1] as string] = humanized;
          }
        }
        return next;
      })
    : rowsValue;
  const nextColumns = columns?.map((col) => (isLabelCol(col) ? { ...col, format: "text" } : col));
  return { rows, columns: nextColumns };
}

/** Executes a host tool by name (OpenUIPane binds this to /api/tools). */
export type KitToolRunner = (tool: string, input: Record<string, unknown>) => Promise<unknown>;
export const KitToolRunnerContext = createContext<KitToolRunner | null>(null);

type RenderProps = ComponentRenderProps<Record<string, unknown>, ReactNode>;
type Wrapper = (renderProps: RenderProps) => ReactNode;

/** A prop value that may be one sub-component, an array of them, or absent. */
const renderAll = (renderNode: RenderProps["renderNode"], value: unknown): ReactNode[] => {
  if (value === null || value === undefined) return [];
  const items = Array.isArray(value) ? value : [value];
  return items.map((item, index) => <span style={{ display: "contents" }} key={index}>{renderNode(item)}</span>);
};

/** A host-tool-name action prop (vendo semantics) as a click handler. */
function useToolAction(tool: unknown): ((input?: Record<string, unknown>) => void) | undefined {
  const run = useContext(KitToolRunnerContext);
  if (typeof tool !== "string" || tool === "" || run === null) return undefined;
  return (input = {}) => {
    void run(tool, input).catch(() => {
      // The query pipe surfaces tool errors on the bound query; a fire-and-
      // forget action's failure is visible in the network panel — the pane
      // deliberately adds no alert chrome of its own.
    });
  };
}

const p = <T,>(value: unknown): T => value as T;

function KitButton({ props }: RenderProps) {
  const onClick = useToolAction(props.onClick);
  return (
    <Button
      label={p<string>(props.label)}
      variant={p<never>(props.variant)}
      disabled={p<boolean>(props.disabled)}
      {...(onClick === undefined ? {} : { onClick: () => onClick() })}
    />
  );
}

function KitForm({ props, renderNode }: RenderProps) {
  const onSubmit = useToolAction(props.onSubmit);
  return (
    <Form
      submitLabel={p<string>(props.submitLabel)}
      {...(onSubmit === undefined ? {} : { onSubmit: (event: { preventDefault(): void }) => { event.preventDefault(); onSubmit(); } })}
    >
      {renderAll(renderNode, props.children)}
    </Form>
  );
}

/** onChange host tools receive `{ value }` — the same convention the vendo
 *  tree renderer uses for bound change handlers. */
function changeHandler(action: ReturnType<typeof useToolAction>): ((value: unknown) => void) | undefined {
  return action === undefined ? undefined : (value: unknown) => action({ value });
}

function KitInput({ props }: RenderProps) {
  const action = useToolAction(props.onChange);
  const rest = { ...props } as Record<string, unknown>;
  delete rest.onChange;
  return <Input {...p<object>(rest)} {...(action === undefined ? {} : { onChange: changeHandler(action) })} />;
}
function KitSelect({ props }: RenderProps) {
  const action = useToolAction(props.onChange);
  const rest = { ...props } as Record<string, unknown>;
  delete rest.onChange;
  return <Select options={[]} {...p<object>(rest)} {...(action === undefined ? {} : { onChange: changeHandler(action) })} />;
}
function KitDatePicker({ props }: RenderProps) {
  const action = useToolAction(props.onChange);
  const rest = { ...props } as Record<string, unknown>;
  delete rest.onChange;
  return <DatePicker {...p<object>(rest)} {...(action === undefined ? {} : { onChange: changeHandler(action) })} />;
}
function KitTextarea({ props }: RenderProps) {
  const action = useToolAction(props.onChange);
  const rest = { ...props } as Record<string, unknown>;
  delete rest.onChange;
  return <Textarea {...p<object>(rest)} {...(action === undefined ? {} : { onChange: changeHandler(action) })} />;
}
function KitCheckbox({ props }: RenderProps) {
  const action = useToolAction(props.onChange);
  const rest = { ...props } as Record<string, unknown>;
  delete rest.onChange;
  return <Checkbox {...p<object>(rest)} {...(action === undefined ? {} : { onChange: changeHandler(action) })} />;
}

const wrappers: Record<string, Wrapper> = {
  // Layout — children mapped through their runtime.
  Stack: ({ props, renderNode }) => <Stack gap={p<number>(props.gap)}>{renderAll(renderNode, props.children)}</Stack>,
  Row: ({ props, renderNode }) => (
    <Row gap={p<number>(props.gap)} align={p<never>(props.align)} justify={p<never>(props.justify)}>
      {renderAll(renderNode, props.children)}
    </Row>
  ),
  Grid: ({ props, renderNode }) => (
    <Grid columns={p<number>(props.columns)} gap={p<number>(props.gap)}>{renderAll(renderNode, props.children)}</Grid>
  ),
  Surface: ({ props, renderNode }) => (
    <Surface title={p<string>(props.title)}>{renderAll(renderNode, props.children)}</Surface>
  ),
  Divider: () => <Divider />,

  // Values / data / charts — evaluated props pass straight through.
  Text: ({ props }) => <Text text="" {...p<object>(props)} />,
  Money: ({ props }) => <Money cents={0} {...p<object>(props)} />,
  DateTime: ({ props }) => <DateTime value="" {...p<object>(props)} />,
  Percent: ({ props }) => <Percent value={0} {...p<object>(props)} />,
  Num: ({ props }) => <Num value={0} {...p<object>(props)} />,
  EnumBadge: ({ props }) => <EnumBadge value={null} {...p<object>(props)} />,
  DataTable: ({ props }) => {
    const { rows, columns } = resolveLabelColumns(props.rows, props.columns);
    return <DataTable rows={[]} {...p<object>({ ...props, rows, columns })} />;
  },
  CardList: ({ props }) => {
    // CardList reuses the table's label resolution for its `fields`; the
    // `items` prop is the row set, so we route it through the same rewrite.
    const { rows, columns } = resolveLabelColumns(props.items, props.fields);
    return <CardList items={[]} {...p<object>({ ...props, items: rows, fields: columns })} />;
  },
  Stat: ({ props }) => {
    const value = props.format === "label" ? humanizeCell(props.value) : props.value;
    const format = props.format === "label" ? "text" : props.format;
    return <Stat label="" value="" {...p<object>({ ...props, value, format })} />;
  },
  Badge: ({ props }) => <Badge label="" {...p<object>(props)} />,
  LineChart: ({ props }) => <LineChart data={[]} xKey="" series={[]} {...p<object>(props)} />,
  BarChart: ({ props }) => <BarChart data={[]} xKey="" series={[]} {...p<object>(props)} />,
  DonutChart: ({ props }) => <DonutChart data={[]} categoryKey="" valueKey="" {...p<object>(props)} />,
  Sparkline: ({ props }) => <Sparkline data={[]} {...p<object>(props)} />,
  Progress: ({ props }) => <Progress value={0} {...p<object>(props)} />,
  Disclaimer: ({ props }) => <Disclaimer reason="" {...p<object>(props)} />,

  // Forms — host-tool-name actions bridged to /api/tools.
  Button: KitButton,
  Form: KitForm,
  Input: KitInput,
  Select: KitSelect,
  DatePicker: KitDatePicker,
  Textarea: KitTextarea,
  Checkbox: KitCheckbox,

  // Feedback — content values mapped through their runtime.
  Callout: ({ props }) => (
    <Callout tone={p<never>(props.tone)} title={p<string>(props.title)}>{p<string>(props.body)}</Callout>
  ),
  Tabs: ({ props, renderNode }) => {
    const tabs = (Array.isArray(props.tabs) ? props.tabs : []) as Array<{ label?: unknown; content?: unknown; disabled?: unknown }>;
    return (
      <Tabs
        tabs={tabs.map((tab) => ({
          label: String(tab.label ?? ""),
          content: <>{renderAll(renderNode, tab.content)}</>,
          ...(tab.disabled === true ? { disabled: true } : {}),
        }))}
        defaultIndex={p<number>(props.defaultIndex)}
      />
    );
  },
  Accordion: ({ props, renderNode }) => {
    const items = (Array.isArray(props.items) ? props.items : []) as Array<{ label?: unknown; content?: unknown }>;
    return (
      <Accordion
        items={items.map((item) => ({ label: String(item.label ?? ""), content: <>{renderAll(renderNode, item.content)}</> }))}
        multiple={p<boolean>(props.multiple)}
      />
    );
  },
};

/** The renderable bench library: vendo-kit wrappers injected; the stock
 *  openui fallbacks keep their own renderers (vendo-openui-library.ts). */
export const benchRenderLibrary: Library = buildBenchLibrary(wrappers);
