import { contentHash } from "@openpond/harness";
import { object } from "../normalize.js";

export const CODEX_AUTHORIZATION_PROJECTION_POLICY = "codex-native-authorization-v1";
const POLICY = CODEX_AUTHORIZATION_PROJECTION_POLICY;
type Omission = { policy: typeof POLICY; sourcePath: string; sourceHash: string; entries: number | null };

/** Native approved-command rules are account authority, not observed tool calls.
 * Retain all other context and the original file/event identity. Unknown formats
 * remain untouched for ordinary privacy admission; this is not secret scrubbing.
 */
export function projectCodexAuthorization(row: Record<string, unknown>) {
  const omissions: Omission[] = [];
  const omit = (sourcePath: string, value: unknown, entries: number | null) => {
    const receipt: Omission = { policy: POLICY, sourcePath, sourceHash: contentHash(value), entries };
    omissions.push(receipt);
    return receipt;
  };
  const permissionsText = (text: string, path: string) => text.replace(
    /<permissions instructions>[\s\S]*?<\/permissions instructions>/gu,
    block => block.replace(
      /^## Approved command prefixes\r?\n[\s\S]*?(?=^## |<\/permissions instructions>)/gmu,
      section => {
        const receipt = omit(path, section, null);
        return `## Approved command prefixes\n[Native authorization rules omitted; policy ${receipt.policy}; source hash ${receipt.sourceHash}]\n`;
      },
    ),
  );
  const payload = object(row.payload);
  if (row.type === "response_item" && payload.type === "message" && ["system", "developer"].includes(String(payload.role))) {
    const content = typeof payload.content === "string"
      ? permissionsText(payload.content, "/payload/content")
      : Array.isArray(payload.content) ? payload.content.map((value, index) => {
        const block = object(value);
        return typeof block.text === "string"
          ? { ...block, text: permissionsText(block.text, `/payload/content/${index}/text`) }
          : value;
      }) : payload.content;
    return { row: { ...row, payload: { ...payload, content } }, omissions };
  }
  if (row.type === "world_state") {
    const state = object(payload.state), permissions = object(state.permissions);
    if (Array.isArray(permissions.approved_command_prefixes)) {
      const receipt = omit("/payload/state/permissions/approved_command_prefixes", permissions.approved_command_prefixes, permissions.approved_command_prefixes.length);
      return { row: { ...row, payload: { ...payload, state: { ...state, permissions: { ...permissions, approved_command_prefixes: { omitted: "native_authorization_state", ...receipt } } } } }, omissions };
    }
  }
  return { row, omissions };
}
