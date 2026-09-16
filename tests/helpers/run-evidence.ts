import { RunEvidenceCollector, type RunEvidence } from "../../src/run-evidence.ts";

// 模拟已从MA本轮历史核实的只读调用；缺失证据的用例不得使用此夹具。
export function readOnlyEvidence(): RunEvidence {
  const collector = new RunEvidenceCollector();
  collector.observe({ id: "original-user-event", type: "user.message" });
  collector.observe({ id: "tool-event", type: "agent.tool_use", tool_use_id: "calendar-call", name: "bash", input: { command: "lark-cli calendar +agenda --as user" } });
  collector.observe({ id: "tool-result", type: "agent.tool_result", tool_use_id: "calendar-call", is_error: false,
    content: [{ type: "text", text: 'exit_code: 3\n--- stderr ---\n{"ok":false,"identity":"user","error":{"type":"authentication","subtype":"token_missing"}}' }] }, true);
  return collector.snapshot("idle");
}
