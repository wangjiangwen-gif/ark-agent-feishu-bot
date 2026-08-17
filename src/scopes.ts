const BASE_SCOPES = ["offline_access", "auth:user.id:read"];

// 与 lark-cli 的业务域命名对齐。宽权限可能在应用创建页显示“不支持自动开通”，
// 但会在随后用户 OAuth 的“常用权限包”中完成开通与授权。
const DOMAIN_SCOPES = {
  // lark-cli 的 create/fetch/update 分别校验细粒度 scope。只申请
  // docx:document + create 会出现“能创建、不能回读或追加”的半可用状态。
  docs: ["docx:document", "docx:document:create", "docx:document:readonly", "docx:document:write_only"],
  drive: ["drive:drive", "drive:file"]
};

const BOT_BASE_SCOPES = [
  "im:message:send_as_bot",
  "im:message:readonly",
  "im:message.p2p_msg:readonly",
  "im:message.group_at_msg:readonly",
  "calendar:calendar",
  "calendar:calendar.event:create",
  "calendar:calendar.event:read"
];

export const SUPPORTED_LARK_DOMAINS = Object.keys(DOMAIN_SCOPES);

export function resolveLarkUserScopes(input: string): string[] {
  return [...BASE_SCOPES, ...resolveBusinessScopes(input)];
}

export function resolveLarkBotScopes(input: string): string[] {
  return [...new Set([...BOT_BASE_SCOPES, ...resolveBusinessScopes(input)])];
}

function resolveBusinessScopes(input: string): string[] {
  const domains = [...new Set(input.split(/[\s,]+/).map(value => value.trim()).filter(Boolean))];
  const unknown = domains.filter(domain => !(domain in DOMAIN_SCOPES));
  if (unknown.length) throw new Error(`暂不支持 lark-cli 业务域：${unknown.join(", ")}；当前支持：${SUPPORTED_LARK_DOMAINS.join(", ")}`);
  return [...new Set(domains.flatMap(domain => DOMAIN_SCOPES[domain as keyof typeof DOMAIN_SCOPES]))];
}
