const BASE_SCOPES = ["offline_access", "auth:user.id:read"];

// 与 lark-cli 的业务域命名对齐。宽权限可能在应用创建页显示“不支持自动开通”，
// 但会在随后用户 OAuth 的“常用权限包”中完成开通与授权。
const DOMAIN_SCOPES = {
  docs: ["docx:document", "docx:document:create"],
  drive: ["drive:drive", "drive:file"]
};

export const SUPPORTED_LARK_DOMAINS = Object.keys(DOMAIN_SCOPES);

export function resolveLarkUserScopes(input: string): string[] {
  const domains = [...new Set(input.split(/[\s,]+/).map(value => value.trim()).filter(Boolean))];
  const unknown = domains.filter(domain => !(domain in DOMAIN_SCOPES));
  if (unknown.length) throw new Error(`暂不支持 lark-cli 业务域：${unknown.join(", ")}；当前支持：${SUPPORTED_LARK_DOMAINS.join(", ")}`);
  return [...new Set([...BASE_SCOPES, ...domains.flatMap(domain => DOMAIN_SCOPES[domain as keyof typeof DOMAIN_SCOPES])])];
}
