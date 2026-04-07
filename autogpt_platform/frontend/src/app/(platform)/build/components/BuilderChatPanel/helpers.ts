import type { CustomNode } from "../FlowEditor/nodes/CustomNode/CustomNode";
import type { CustomEdge } from "../FlowEditor/edges/CustomEdge";

export type GraphAction =
  | {
      type: "update_node_input";
      nodeId: string;
      key: string;
      value: unknown;
    }
  | {
      type: "connect_nodes";
      source: string;
      target: string;
      sourceHandle: string;
      targetHandle: string;
    };

export function serializeGraphForChat(
  nodes: CustomNode[],
  edges: CustomEdge[],
): string {
  if (nodes.length === 0) return "The graph is currently empty.";

  const nodeLines = nodes.map((n) => {
    const name = n.data.metadata?.customized_name || n.data.title;
    const desc = n.data.description ? ` — ${n.data.description}` : "";
    return `- Node ${n.id}: "${name}"${desc}`;
  });

  const edgeLines = edges.map((e) => {
    const src = nodes.find((n) => n.id === e.source);
    const tgt = nodes.find((n) => n.id === e.target);
    const srcName =
      src?.data.metadata?.customized_name || src?.data.title || e.source;
    const tgtName =
      tgt?.data.metadata?.customized_name || tgt?.data.title || e.target;
    return `- "${srcName}" (${e.sourceHandle}) → "${tgtName}" (${e.targetHandle})`;
  });

  const parts = [`Blocks (${nodes.length}):\n${nodeLines.join("\n")}`];
  if (edgeLines.length > 0) {
    parts.push(`Connections (${edges.length}):\n${edgeLines.join("\n")}`);
  }
  return parts.join("\n\n");
}

export function parseGraphActions(text: string): GraphAction[] {
  const actions: GraphAction[] = [];
  const jsonBlockRegex = /```(?:json)?\s*\n?([\s\S]*?)\n?```/g;
  let match: RegExpExecArray | null;

  while ((match = jsonBlockRegex.exec(text)) !== null) {
    try {
      const parsed = JSON.parse(match[1]) as unknown;
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        !("action" in parsed)
      ) {
        continue;
      }
      const obj = parsed as Record<string, unknown>;
      if (obj.action === "update_node_input") {
        actions.push({
          type: "update_node_input",
          nodeId: String(obj.node_id ?? ""),
          key: String(obj.key ?? ""),
          value: obj.value,
        });
      } else if (obj.action === "connect_nodes") {
        actions.push({
          type: "connect_nodes",
          source: String(obj.source ?? ""),
          target: String(obj.target ?? ""),
          sourceHandle: String(obj.source_handle ?? ""),
          targetHandle: String(obj.target_handle ?? ""),
        });
      }
    } catch {
      // Not valid JSON, skip
    }
  }
  return actions;
}
