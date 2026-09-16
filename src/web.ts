import { createServer, type AddressInfo, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { EmployeeConfig } from "./config.ts";
import { getConnectedIdentities } from "./identities.ts";
import type { GatewayStore } from "./store.ts";
import type { Gateway } from "./gateway.ts";

export type EmployeeOverview = {
  id: string;
  botName: string;
  appId: string;
  agentId: string;
  environmentId: string;
  startedAt: string;
};

export type EmployeeSummary = EmployeeOverview & {
  status: "online";
  userCount: number;
  lastActivityAt?: string;
};

export async function startEmployeeWeb(options: {
  store: GatewayStore;
  config: EmployeeConfig;
  botName?: string;
  recovery?: Pick<Gateway, "listRecoveryTasks" | "controlRecoveryTask">;
}): Promise<{ server: Server; url: string }> {
  const startedAt = new Date().toISOString();
  const employeeId = options.config.arkAgentId;
  const overview = (): EmployeeOverview => ({
    id: employeeId, botName: options.botName || "飞书数字员工", appId: options.config.feishuAppId,
    agentId: options.config.arkAgentId, environmentId: options.config.arkEnvironmentId, startedAt
  });
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url || "/", `http://${options.config.webHost}:${options.config.webPort}`);
      if (request.method === "GET" && url.pathname === "/") return html(response, WEB_HTML);
      if (!authorized(request.headers.authorization, options.config.webToken)) return json(response, 401, { error: "unauthorized" });
      const employeePath = `/api/employees/${encodeURIComponent(employeeId)}`;
      if (url.pathname === `${employeePath}/attachments`) {
        if (request.method !== "GET") return json(response, 405, { error: "method_not_allowed" });
        const query = url.searchParams;
        if ([...query.keys()].some(key => !["before", "messageId", "sessionId"].includes(key) || query.getAll(key).length !== 1)) {
          return json(response, 400, { error: "附件筛选参数无效" });
        }
        const cursor = query.get("before");
        if (cursor !== null && (!/^[1-9]\d{0,15}$/.test(cursor) || !Number.isSafeInteger(Number(cursor)))) {
          return json(response, 400, { error: "附件阶段游标无效" });
        }
        const messageId = query.get("messageId") ?? undefined, sessionId = query.get("sessionId") ?? undefined;
        if ([messageId, sessionId].some(value => value !== undefined && (!value || value.length > 256 || /[\u0000-\u001f\u007f]/.test(value)))) {
          return json(response, 400, { error: "附件筛选参数无效" });
        }
        try {
          return json(response, 200, options.store.attachmentTrace.listForInstallation("lark", options.config.feishuAppId,
            { ...(cursor === null ? {} : { before: Number(cursor) }), messageId, sessionId }));
        } catch { return json(response, 500, { error: "附件阶段记录读取失败，请检查本地数据库" }); }
      }
      if (url.pathname === `${employeePath}/recovery`) {
        if (request.method === "GET") {
          const cursor = url.searchParams.get("after") || "0";
          if (!/^\d{1,16}$/.test(cursor) || !Number.isSafeInteger(Number(cursor))) return json(response, 400, { error: "任务分页游标无效" });
          return json(response, 200, options.recovery?.listRecoveryTasks("lark", options.config.feishuAppId, Number(cursor)) || { enabled: false, items: [] });
        }
        if (request.method === "POST") {
          if (!options.recovery) return json(response, 409, { error: "任务恢复未启用" });
          if (request.headers["sec-fetch-site"] === "cross-site" || (request.headers.origin && request.headers.origin !== `http://${request.headers.host}`)) return json(response, 403, { error: "禁止跨站管理操作" });
          if (request.headers["content-type"]?.split(";")[0].trim() !== "application/json") return json(response, 415, { error: "需要JSON请求" });
          let body: Record<string, unknown>;
          try { body = await readControlBody(request); }
          catch { return json(response, 400, { error: "任务操作参数无效或超过限制" }); }
          if (typeof body.id !== "string" || !/^[a-f0-9-]{36}$/.test(body.id) || !Number.isSafeInteger(body.revision) || Number(body.revision) < 1
            || !["reconcile", "discard"].includes(String(body.action)) || (body.action === "discard" && body.confirmDiscard !== body.id)) return json(response, 400, { error: "需要有效任务版本和显式放弃确认" });
          try { await options.recovery.controlRecoveryTask("lark", options.config.feishuAppId, body.id, Number(body.revision), body.action as "reconcile" | "discard"); }
          catch { return json(response, 409, { error: "任务未能处理：请刷新检查状态。运行未结束、仍需授权、版本或绑定变化时不能放弃；结果未知请保留原任务。" }); }
          return json(response, 200, { ok: true });
        }
        return json(response, 405, { error: "method_not_allowed" });
      }
      const users = options.store.listEmployeeUsers();
      const audit = options.store.listAuditLogs();
      if (request.method === "GET" && url.pathname === "/api/employees") return json(response, 200, [{
        ...overview(), status: "online", userCount: users.length, lastActivityAt: audit[0]?.createdAt
      } satisfies EmployeeSummary]);
      if (request.method === "GET" && url.pathname === employeePath) return json(response, 200, overview());
      if (request.method === "GET" && url.pathname === `${employeePath}/identities`) return json(response, 200, getConnectedIdentities(options.config));
      if (request.method === "GET" && url.pathname === `${employeePath}/users`) return json(response, 200, users);
      if (request.method === "GET" && url.pathname === `${employeePath}/audit`) return json(response, 200, audit);
      // 兼容已打开的旧版页面，后续可移除。
      if (request.method === "GET" && url.pathname === "/api/overview") return json(response, 200, overview());
      if (request.method === "GET" && url.pathname === "/api/identities") return json(response, 200, getConnectedIdentities(options.config));
      if (request.method === "GET" && url.pathname === "/api/users") return json(response, 200, users);
      if (request.method === "GET" && url.pathname === "/api/audit") return json(response, 200, audit);
      return json(response, 404, { error: "not_found" });
    } catch (error) {
      return json(response, 400, { error: error instanceof Error ? error.message : "request_failed" });
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.config.webPort, options.config.webHost, () => { server.off("error", reject); resolve(); });
  });
  const address = server.address() as AddressInfo;
  return { server, url: `http://${options.config.webHost}:${address.port}/#token=${encodeURIComponent(options.config.webToken)}` };
}

async function readControlBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []; let size = 0;
  request.setTimeout(5000, () => request.destroy());
  try {
    for await (const chunk of request) {
      const bytes = Buffer.from(chunk); size += bytes.length;
      if (size > 4096) throw new Error("oversize");
      chunks.push(bytes);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("invalid body");
    return body;
  } finally { request.setTimeout(0); }
}

function authorized(header: string | undefined, token: string): boolean {
  return header === `Bearer ${token}`;
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
  response.end(JSON.stringify(body));
}

function html(response: ServerResponse, body: string): void {
  response.writeHead(200, {
    "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'"
  });
  response.end(body);
}

const WEB_HTML = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>数字员工控制台</title><style>
:root{font-family:Inter,ui-sans-serif,system-ui,-apple-system,sans-serif;color:#172033;background:#f5f7fb}*{box-sizing:border-box}body{margin:0}.shell{max-width:1120px;margin:auto;padding:40px 24px 80px}.eyebrow{color:#4f6bed;font-weight:750;letter-spacing:.04em}.title{font-size:34px;margin:8px 0}.sub{color:#687386;margin:0 0 28px}.error{display:none;background:#fff0f0;color:#b42318;padding:12px;border-radius:10px;margin-bottom:16px}.view{display:none}.view.active{display:block}.toolbar{display:flex;align-items:end;justify-content:space-between;gap:16px;margin-bottom:16px}.section-title{font-size:22px;margin:0}.muted{color:#7b8498;font-size:13px}.employee-list{display:grid;gap:12px}.employee-row{width:100%;display:grid;grid-template-columns:minmax(220px,1.5fr) minmax(180px,1fr) 100px 130px 180px;align-items:center;gap:18px;text-align:left;background:#fff;border:1px solid #e3e8f2;border-radius:14px;padding:20px;box-shadow:0 5px 24px #22315b0a;cursor:pointer;color:inherit}.employee-row:hover{border-color:#9aacf5;box-shadow:0 8px 30px #315efb14}.employee-name{font-size:18px;font-weight:720}.meta{color:#687386;font-size:13px;margin-top:5px;overflow-wrap:anywhere}.status{display:inline-block;padding:4px 9px;border-radius:99px;background:#e8f7ee;color:#18864b;font-size:12px}.arrow{font-size:20px;color:#8190af;text-align:right}.back{border:0;background:transparent;color:#315efb;padding:0;margin-bottom:18px;cursor:pointer;font-size:14px}.detail-head{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:24px}.detail-title{font-size:28px;margin:0}.tabs{display:flex;gap:8px;margin-bottom:20px;flex-wrap:wrap}.tabs button{border:0;border-radius:9px;padding:10px 15px;background:#e8ecf7;color:#27324a;cursor:pointer}.tabs button.active{background:#315efb;color:white}.panel{display:none}.panel.active{display:block}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px}.identity,.table-wrap{background:white;border:1px solid #e3e8f2;border-radius:14px;padding:18px;box-shadow:0 5px 24px #22315b0a}.identity-head{display:flex;align-items:center;justify-content:space-between;gap:12px}.identity-title{font-size:19px;font-weight:700}.identity-meta{color:#687386;margin-top:5px}.identity-details{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:16px;margin-top:20px}.label{color:#7b8498;font-size:13px}.value{font-weight:650;margin-top:7px;overflow-wrap:anywhere}.chips{display:flex;gap:7px;flex-wrap:wrap;margin-top:8px}.chip{background:#eef2ff;color:#3348a5;border-radius:99px;padding:5px 9px;font-size:12px}.scope{background:#f3f5f8;color:#566074}.note{background:#eef4ff;color:#42526e;padding:12px 14px;border-radius:10px;margin-bottom:14px;font-size:13px}table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:12px 10px;border-bottom:1px solid #edf0f5;font-size:14px}th{color:#6d768a}.empty{color:#8b94a6;text-align:center;padding:30px}@media(max-width:780px){.shell{padding:24px 14px}.title{font-size:28px}.employee-row{grid-template-columns:1fr 90px}.employee-row>:nth-child(2),.employee-row>:nth-child(4){display:none}.table-wrap{overflow:auto}}
</style></head><body><main class="shell"><div class="eyebrow">ARKAGENT EMPLOYEE</div><h1 class="title">数字员工控制台</h1><p class="sub">集中查看数字员工及其身份、行为和访问记录。</p><div id="error" class="error"></div>
<section id="list-view" class="view active"><div class="toolbar"><div><h2 class="section-title">数字员工</h2><div class="muted">当前运行在此 Gateway 的数字员工</div></div><div id="employee-count" class="muted"></div></div><div id="employee-list" class="employee-list"></div></section>
<section id="detail-view" class="view"><button id="back" class="back">← 返回数字员工列表</button><div class="detail-head"><div><h2 id="detail-name" class="detail-title"></h2><div id="detail-meta" class="meta"></div></div><span class="status">● 在线</span></div>
<nav class="tabs"><button class="active" data-tab="identities">身份</button><button data-tab="audit">行为日志</button><button data-tab="users">访问过的用户</button></nav>
<section id="identities" class="panel active"><div id="identities-list" class="grid"></div></section>
<section id="audit" class="panel"><div class="toolbar"><h3>待处理任务</h3><div><button id="recovery-refresh" type="button">刷新</button> <button id="recovery-next" type="button" hidden>下一页</button></div></div><div class="note">重新核查不会重跑任务。放弃仅结束网关记录，要求原MA运行已经结束；不会撤销已创建的文档、日程等操作，也不代表回复已送达。管理操作使用当前控制台凭证。</div><div id="recovery-status" class="muted" role="status"></div><div class="table-wrap"><table><thead><tr><th>消息 / 会话</th><th>任务状态</th><th>MA核查 / 回复</th><th>操作</th></tr></thead><tbody id="recovery-body"></tbody></table></div><h3>行为日志</h3><div class="table-wrap"><table><thead><tr><th>时间</th><th>用户</th><th>动作</th><th>状态</th><th>耗时</th><th>Session</th></tr></thead><tbody id="audit-body"></tbody></table></div>
<h3>附件处理记录</h3>
<div class="note">当前飞书应用的历史记录，可能包含切换 Agent 前的记录。这里只显示本地准备阶段证据，不代表模型已理解文件，也不会触发下载、重传或任务续跑。未记录结束不等于仍在处理；阶段报错也不证明远端没有写入。旧版没有记录的附件不会自动补造记录。</div>
<form id="attachment-filter" class="toolbar" style="flex-wrap:wrap"><label>源消息 ID <input id="attachment-message" maxlength="256" placeholder="文件所在消息，可留空"></label><label>Session ID <input id="attachment-session" maxlength="256" placeholder="仅匹配已记录该会话的阶段"></label><button type="submit">查询 / 刷新</button><button id="attachment-next" type="button" hidden>更早记录</button></form>
<div id="attachment-status" class="muted" role="status"></div>
<div class="table-wrap" style="overflow-x:auto"><table id="attachment-table" style="table-layout:fixed;min-width:900px"><thead><tr><th>时间 / 耗时</th><th>来源消息 / 群 / 话题</th><th>附件标识 / 阶段</th><th>阶段结果</th><th>File / Session</th><th>路径 / 字节数 / SHA-256</th></tr></thead><tbody id="attachment-body" style="overflow-wrap:anywhere;vertical-align:top"></tbody></table></div>
</section>
<section id="users" class="panel"><div class="note">使用权限由飞书应用可用范围管理；此处只展示实际访问过该数字员工的用户。</div><div class="table-wrap"><table><thead><tr><th>用户 open_id</th><th>租户</th><th>首次访问</th><th>最近访问</th><th>访问次数</th></tr></thead><tbody id="users-body"></tbody></table></div></section>
</section></main><script>
const token=new URLSearchParams(location.hash.slice(1)).get('token')||'';const headers={Authorization:'Bearer '+token};let currentEmployee='';const esc=v=>String(v??'');
async function api(path){const r=await fetch(path,{headers});if(!r.ok)throw new Error((await r.json()).error||r.statusText);return r.json()}
function showError(e){const n=document.querySelector('#error');n.textContent=e.message||String(e);n.style.display='block'}
let recoveryNext=0;
async function loadRecovery(after=0){const base=employeeBase(),page=await api(base+'/recovery?after='+after);if(base!==employeeBase())return;const body=document.querySelector('#recovery-body');recoveryNext=page.next||0;document.querySelector('#recovery-next').hidden=!recoveryNext;document.querySelector('#recovery-status').textContent=page.enabled?'按到达顺序展示，每页最多100条；核查状态是最近一次记录，不代表实时状态。':'持久化队列尚未启用，当前不提供任务恢复管理。';body.replaceChildren(...page.items.map(x=>{const tr=document.createElement('tr');[x.messageId+' / '+(x.sessionId||'尚无Session'),x.state+(x.bindingMatches?'':'（绑定已变化）'),x.runStatus+' / '+(x.replyConfirmed?'已确认回复':x.deliveryPhase||'未确认回复')].forEach(v=>{const td=document.createElement('td');td.textContent=v;tr.append(td)});const actions=document.createElement('td');if(x.state==='uncertain'&&x.bindingMatches){for(const action of ['reconcile','discard']){const button=document.createElement('button');button.type='button';button.textContent=action==='reconcile'?'重新核查':'放弃任务';button.onclick=async()=>{if(action==='discard'&&!window.confirm('确认放弃此任务？系统会先核查MA是否已结束。不会撤销已有外部操作，不会重新执行或补发回复，后续排队消息可能开始执行。'))return;actions.querySelectorAll('button').forEach(b=>b.disabled=true);try{const r=await fetch(base+'/recovery',{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({id:x.id,revision:x.revision,action,...(action==='discard'?{confirmDiscard:x.id}:{})})});if(!r.ok)throw new Error((await r.json()).error);if(base===employeeBase()){await loadRecovery();await loadAudit()}}catch(e){showError(e);if(base===employeeBase())await loadRecovery().catch(showError)}};actions.append(button)}}else actions.textContent='—';tr.append(actions);return tr}));if(!page.items.length){const tr=document.createElement('tr'),td=document.createElement('td');td.colSpan=4;td.className='empty';td.textContent='本页暂无待处理任务';tr.append(td);body.append(tr)}}
document.querySelector('#recovery-refresh').onclick=()=>loadRecovery().catch(showError);document.querySelector('#recovery-next').onclick=()=>loadRecovery(recoveryNext).catch(showError);
function employeeBase(){return '/api/employees/'+encodeURIComponent(currentEmployee)}
let attachmentNext=0,attachmentRequest=0;
function renderAttachmentRows(items){
  const stages={download:'从飞书下载',upload:'上传到 MA',mount:'挂载到 Session',mount_check:'核查远端挂载',inline:'准备纯文本',cache:'复用附件缓存'};
  const states={pending:'未记录结束（结果待核实）',succeeded:'此阶段已确认',error:'此阶段报错（不代表远端未写入）'};
  const rows=items.map(x=>{
    const tr=document.createElement('tr');
    const values=[new Date(x.startedAt).toLocaleString()+' / '+(x.durationMs==null?'耗时未知':x.durationMs+' ms'),
      x.messageId+' / '+x.conversationId+' / '+(x.threadId||'非话题')+' / 租户 '+x.tenantId,
      x.attachmentKey+' / '+(stages[x.stage]||'未知阶段'),states[x.status]||'未知状态',
      (x.fileId||'未记录 File ID')+' / '+(x.sessionId||'未记录 Session ID'),
      (x.mountPath||'未记录路径')+' / '+(x.bytes==null?'大小未知':x.bytes+' B')+' / '+(x.sha256||'未记录 Hash')];
    values.forEach(value=>{const td=document.createElement('td');td.textContent=value;tr.append(td)});return tr;
  });
  if(!rows.length){const tr=document.createElement('tr'),td=document.createElement('td');td.colSpan=6;td.className='empty';td.textContent='暂无匹配的附件阶段记录';tr.append(td);rows.push(tr)}
  document.querySelector('#attachment-body').replaceChildren(...rows);
}
async function loadAttachments(before){
  const request=++attachmentRequest,base=employeeBase(),query=new URLSearchParams();
  const messageId=document.querySelector('#attachment-message').value.trim(),sessionId=document.querySelector('#attachment-session').value.trim();
  if(messageId)query.set('messageId',messageId);if(sessionId)query.set('sessionId',sessionId);if(before)query.set('before',String(before));
  const status=document.querySelector('#attachment-status'),next=document.querySelector('#attachment-next');
  next.hidden=true;attachmentNext=0;document.querySelector('#attachment-body').replaceChildren();status.textContent='正在读取本地阶段记录…';
  try{
    const page=await api(base+'/attachments?'+query);
    if(request!==attachmentRequest||base!==employeeBase())return;
    renderAttachmentRows(page.items);attachmentNext=page.next||0;next.hidden=!attachmentNext;
    status.textContent='按开始顺序倒序，每页最多100条。查询仅读本地记录；按 Session 筛选不包含尚未绑定会话的下载/上传阶段。';
  }catch(error){if(request!==attachmentRequest||base!==employeeBase())return;status.textContent='读取失败，当前没有可展示的查询结果。';showError(error)}
}
document.querySelector('#attachment-filter').onsubmit=event=>{event.preventDefault();loadAttachments()};
document.querySelector('#attachment-next').onclick=()=>loadAttachments(attachmentNext);
for(const id of ['#attachment-message','#attachment-session'])document.querySelector(id).oninput=()=>{
  attachmentRequest++;attachmentNext=0;document.querySelector('#attachment-next').hidden=true;
  document.querySelector('#attachment-body').replaceChildren();document.querySelector('#attachment-status').textContent='筛选条件已修改，请点击查询。';
};
async function loadEmployees(){const xs=await api('/api/employees'),list=document.querySelector('#employee-list');document.querySelector('#employee-count').textContent=xs.length+' 个数字员工';list.replaceChildren(...xs.map(x=>{const row=document.createElement('button');row.className='employee-row';row.type='button';const identity=document.createElement('div');const name=document.createElement('div');name.className='employee-name';name.textContent=x.botName;const id=document.createElement('div');id.className='meta';id.textContent=x.agentId;identity.append(name,id);const bot=document.createElement('div');bot.innerHTML='<div class="label">飞书身份</div>';const botValue=document.createElement('div');botValue.className='value';botValue.textContent='Bot · '+x.appId;bot.append(botValue);const status=document.createElement('div');status.innerHTML='<span class="status">● 在线</span>';const users=document.createElement('div');users.innerHTML='<div class="label">访问用户</div>';const userValue=document.createElement('div');userValue.className='value';userValue.textContent=x.userCount+' 人';users.append(userValue);const activity=document.createElement('div');activity.innerHTML='<div class="label">最近活动</div>';const activityValue=document.createElement('div');activityValue.className='value';activityValue.textContent=x.lastActivityAt?new Date(x.lastActivityAt).toLocaleString():'暂无';activity.append(activityValue);const arrow=document.createElement('div');arrow.className='arrow';arrow.textContent='›';row.append(identity,bot,status,users,activity,arrow);row.onclick=()=>openEmployee(x);return row}));if(!xs.length){const n=document.createElement('div');n.className='empty';n.textContent='暂无数字员工';list.append(n)}}
async function openEmployee(employee){currentEmployee=employee.id;document.querySelector('#detail-name').textContent=employee.botName;document.querySelector('#detail-meta').textContent='飞书 Bot · '+employee.appId+'　|　Agent '+employee.agentId;document.querySelector('#list-view').classList.remove('active');document.querySelector('#detail-view').classList.add('active');activateTab('identities')}
function detail(label,value){const n=document.createElement('div'),a=document.createElement('div'),b=document.createElement('div');a.className='label';a.textContent=label;b.className='value';b.textContent=esc(value);n.append(a,b);return n}
function chips(label,values,scope=false){const n=document.createElement('div'),a=document.createElement('div'),b=document.createElement('div');a.className='label';a.textContent=label;b.className='chips';values.forEach(value=>{const c=document.createElement('span');c.className='chip'+(scope?' scope':'');c.textContent=value;b.append(c)});n.append(a,b);return n}
async function loadIdentities(){const xs=await api(employeeBase()+'/identities'),list=document.querySelector('#identities-list');list.replaceChildren(...xs.map(x=>{const c=document.createElement('article');c.className='identity';const head=document.createElement('div');head.className='identity-head';const title=document.createElement('div'),name=document.createElement('div'),meta=document.createElement('div'),status=document.createElement('span');name.className='identity-title';name.textContent=x.displayName;meta.className='identity-meta';meta.textContent=x.providerName+' · '+x.identityTypeLabel;title.append(name,meta);status.className='status';status.textContent='已配置';head.append(title,status);const details=document.createElement('div');details.className='identity-details';details.append(detail(x.identifierLabel,x.identifier),detail('认证方式',x.authMode),detail('凭证来源',x.credentialSource),detail('凭证引用',x.credentialRef),chips('可用能力',x.capabilities),chips('授权范围',x.scopes,true));c.append(head,details);return c}))}
async function loadUsers(){const xs=await api(employeeBase()+'/users'),body=document.querySelector('#users-body');body.replaceChildren(...xs.map(x=>{const tr=document.createElement('tr');[x.openId,x.tenantKey,new Date(x.firstUsedAt).toLocaleString(),new Date(x.lastUsedAt).toLocaleString(),x.usageCount].forEach(v=>{const td=document.createElement('td');td.textContent=esc(v);tr.append(td)});return tr}));if(!xs.length){const tr=document.createElement('tr'),td=document.createElement('td');td.colSpan=5;td.className='empty';td.textContent='暂无访问记录';tr.append(td);body.append(tr)}}
async function loadAudit(){const xs=await api(employeeBase()+'/audit'),body=document.querySelector('#audit-body');body.replaceChildren(...xs.map(x=>{const tr=document.createElement('tr');[new Date(x.createdAt).toLocaleString(),x.openId,x.action,x.status,x.durationMs==null?'—':x.durationMs+' ms',x.sessionId||'—'].forEach(v=>{const td=document.createElement('td');td.textContent=esc(v);tr.append(td)});return tr}));if(!xs.length){const tr=document.createElement('tr'),td=document.createElement('td');td.colSpan=6;td.className='empty';td.textContent='暂无行为日志';tr.append(td);body.append(tr)}}
function activateTab(name){document.querySelectorAll('[data-tab],.panel').forEach(x=>x.classList.remove('active'));document.querySelector('[data-tab="'+name+'"]').classList.add('active');document.querySelector('#'+name).classList.add('active');if(name==='identities')loadIdentities().catch(showError);if(name==='users')loadUsers().catch(showError);if(name==='audit'){loadAudit().catch(showError);loadRecovery().catch(showError);loadAttachments()}}
document.querySelectorAll('[data-tab]').forEach(b=>b.onclick=()=>activateTab(b.dataset.tab));document.querySelector('#back').onclick=()=>{currentEmployee='';document.querySelector('#detail-view').classList.remove('active');document.querySelector('#list-view').classList.add('active');loadEmployees().catch(showError)};loadEmployees().catch(showError);
</script></body></html>`;
