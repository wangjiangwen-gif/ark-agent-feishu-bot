import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const script = fileURLToPath(new URL("../scripts/probe-prepared-recovery.mjs", import.meta.url));
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "ark-probe-script-test-"));
  const config = join(dir, "synthetic.env"), preload = join(dir, "mock-fetch.mjs");
  // 只生成无效的测试凭证；预加载器替换fetch，所有URL均由本地模拟处理，绝不回退真实网络。
  writeFileSync(config, ["ARK_API_KEY=fixture-only-not-a-key", "ARK_AGENT_ID=agent-fixture", "ARK_ENVIRONMENT_ID=env-fixture",
    "ARK_VAULT_ID=vault-fixture", "ARK_CREDENTIAL_ID=credential-fixture", "FEISHU_APP_ID=cli-fixture",
    "FEISHU_APP_SECRET=fixture-only-not-a-secret", "ARKAGENT_WEB_TOKEN=fixture-only-not-a-token"].join("\n"));
  writeFileSync(preload, `
    import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
    const path=${JSON.stringify(join(dir, "remote.json"))}, calls=${JSON.stringify(join(dir, "http.ndjson"))};
    const id='sesn-probe-script-fixture';let stream;
    const read=()=>{try{return JSON.parse(readFileSync(path,'utf8'));}catch{return{};}};
    const events=()=>{const state=read();return state.input?[
      {id:'event-user',type:'user.message',content:[{type:'text',text:state.input}]},
      {id:'event-answer',type:'agent.message',content:[{type:'text',text:state.nonce}]},
      {id:'event-idle',type:'session.status_idle'}]:[];};
    globalThis.fetch=async(input,init={})=>{
      const url=new URL(String(input)),method=init.method||'GET';
      appendFileSync(calls,JSON.stringify({method,path:url.pathname,child:process.argv[2]==='--child'})+'\\n');
      if(url.origin!=='https://ark.cn-beijing.volces.com')throw Error('mock forbids unknown origin');
      if(method==='GET'&&url.pathname==='/api/v3/environments/env-fixture')return Response.json({config:{type:'sandbox',env:{}}});
      if(method==='POST'&&url.pathname==='/api/v3/sessions'){
        const body=JSON.parse(init.body);if(body.vault_ids?.length!==0)throw Error('mock forbids vault');
        writeFileSync(path,JSON.stringify({created:body}));return Response.json({id});
      }
      if(method==='GET'&&url.pathname==='/api/v3/sessions/'+id)return Response.json({id,type:'session',agent:{id:'agent-fixture'},status:process.env.PROBE_MOCK_RUNNING==='1'?'running':'idle'});
      if(method==='GET'&&url.pathname==='/api/v3/sessions/'+id+'/events/stream')return new Response(new ReadableStream({start(controller){stream=controller;}}),{headers:{'content-type':'text/event-stream'}});
      if(url.pathname==='/api/v3/sessions/'+id+'/events'){
        if(method==='POST'){
          const body=JSON.parse(init.body),input=body.events[0].content[0].text,nonce=input.match(/PREPARED_[a-f0-9]{32}/)?.[0];
          writeFileSync(path,JSON.stringify({...read(),input,nonce}));
          if(stream){stream.enqueue(new TextEncoder().encode(events().map(event=>'data: '+JSON.stringify(event)+'\\n\\n').join('')));stream.close();}
          return Response.json({});
        }
        if(method==='GET')return Response.json({data:events()});
      }
      throw Error('mock forbids unknown operation');
    };
  `);
  return { dir, config, preload, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
function run(files: ReturnType<typeof setup>, args: string[], running = false) {
  const child = spawnSync(process.execPath, ["--experimental-strip-types", script, ...args], {
    encoding: "utf8", timeout: 12_000,
    env: { ...process.env, NODE_OPTIONS: `--import=${pathToFileURL(files.preload).href}`, PROBE_MOCK_RUNNING: running ? "1" : "0" }
  });
  const output = child.stdout.split("\n").filter(Boolean).map(line => JSON.parse(line));
  return { child, output, final: output.at(-1) };
}
function cleanupEvidence(dir: string | undefined) {
  if (dir?.startsWith(join(tmpdir(), "ark-prepared-live-"))) rmSync(dir, { recursive: true, force: true });
}

for (const phase of ["ready", "preparing"] as const) test(`recovery probe supports ${phase} exit with only mock HTTP`, () => {
  const files = setup(); let evidence: string | undefined;
  try {
    const result = run(files, ["--live", files.config, ...(phase === "preparing" ? ["--preparing"] : [])]);
    evidence = result.final?.evidenceDir;
    assert.equal(result.child.status, 0, result.child.stdout + result.child.stderr);
    assert.equal(result.final.stage, "passed"); assert.equal(result.final.phase, phase);
    assert.equal(result.final.counts.httpCreates, 0); assert.equal(result.final.counts.httpMessages, 1);
    assert.equal(result.final.counts.credentialMaintenance, phase === "preparing" ? 0 : 1);
    assert.equal(result.final.userMessages, 1); assert.equal(result.final.toolUses, 0); assert.equal(result.final.compactCommands, 0);
    const meta = JSON.parse(readFileSync(join(evidence!, "probe.json"), "utf8")); assert.equal(meta.phase, phase);
    const prepared = JSON.parse(readFileSync(join(evidence!, "child-evidence.json"), "utf8"));
    assert.equal(prepared.stage, phase === "preparing" ? "preparing_after_session_create" : "prepared_before_dispatch");
    assert.equal(prepared.counts.httpCreates, 1); assert.equal(prepared.counts.httpMessages, 0);
    const calls = readFileSync(join(files.dir, "http.ndjson"), "utf8").trim().split("\n").map(line => JSON.parse(line));
    assert.equal(calls.filter(call => call.method === "POST" && call.path.endsWith("/sessions")).length, 1);
    assert.equal(calls.filter(call => call.method === "POST" && call.path.endsWith("/events")).length, 1);
    assert.ok(calls.filter(call => !call.child && call.method === "POST").every(call => call.path.endsWith("/events")));
  } finally { cleanupEvidence(evidence); files.cleanup(); }
});

test("probe explicit resume uses the persisted preparing phase rather than CLI arguments", () => {
  const files = setup(); let evidence: string | undefined;
  try {
    const stopped = run(files, ["--live", files.config, "--preparing"], true); evidence = stopped.final?.evidenceDir;
    assert.equal(stopped.child.status, 1); assert.equal(stopped.final.counts.httpMessages, 0);
    assert.equal(stopped.final.phase, "preparing");
    const resumed = run(files, ["--resume", files.config, evidence!]);
    assert.equal(resumed.child.status, 0, resumed.child.stdout + resumed.child.stderr);
    assert.equal(resumed.final.stage, "passed"); assert.equal(resumed.final.phase, "preparing");
    assert.equal(resumed.final.counts.credentialMaintenance, 0); assert.equal(resumed.final.counts.httpCreates, 0);
    assert.equal(resumed.final.counts.httpMessages, 1);
  } finally { cleanupEvidence(evidence); files.cleanup(); }
});

test("probe explicit resume preserves compatibility with legacy ready metadata without phase", () => {
  const files = setup(); let evidence: string | undefined;
  try {
    const stopped = run(files, ["--live", files.config], true); evidence = stopped.final?.evidenceDir;
    assert.equal(stopped.child.status, 1); assert.equal(stopped.final.counts.httpMessages, 0);
    for (const file of ["probe.json", "child-evidence.json"]) {
      const path = join(evidence!, file), payload = JSON.parse(readFileSync(path, "utf8")); delete payload.phase;
      writeFileSync(path, JSON.stringify(payload));
    }
    const resumed = run(files, ["--resume", files.config, evidence!]);
    assert.equal(resumed.child.status, 0, resumed.child.stdout + resumed.child.stderr);
    assert.equal(resumed.final.stage, "passed"); assert.equal(resumed.final.phase, "ready");
    assert.equal(resumed.final.counts.credentialMaintenance, 1); assert.equal(resumed.final.counts.httpMessages, 1);
  } finally { cleanupEvidence(evidence); files.cleanup(); }
});

for (const from of ["ready", "preparing"] as const) test(`probe refuses a ${from} checkpoint relabelled as a different phase`, () => {
  const files = setup(); let evidence: string | undefined;
  try {
    const stopped = run(files, ["--live", files.config, ...(from === "preparing" ? ["--preparing"] : [])], true);
    evidence = stopped.final?.evidenceDir; assert.equal(stopped.child.status, 1); assert.equal(stopped.final.counts.httpMessages, 0);
    const path = join(evidence!, "probe.json"), meta = JSON.parse(readFileSync(path, "utf8"));
    meta.phase = from === "ready" ? "preparing" : "ready"; writeFileSync(path, JSON.stringify(meta));
    const resumed = run(files, ["--resume", files.config, evidence!]);
    assert.equal(resumed.child.status, 1); assert.equal(resumed.final.reason, "child_did_not_exit_prepared");
    assert.equal(resumed.final.counts.httpMessages, 0); assert.equal(resumed.final.counts.httpCreates, 0);
    assert.equal(resumed.final.counts.credentialMaintenance, 0);
  } finally { cleanupEvidence(evidence); files.cleanup(); }
});
