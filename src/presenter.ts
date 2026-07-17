import { spawn } from "node:child_process";
import path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ProjectionRegistry } from "./projections.ts";
import type { MissionStore } from "./store.ts";
import { runMission } from "./runtime.ts";

export interface GlimpseWindowAdapter {
  on(event: "ready", listener: () => void): void;
  on(event: "message", listener: (message: unknown) => void): void;
  on(event: "closed", listener: () => void): void;
  on(event: "error", listener: (error: Error) => void): void;
  send(script: string): void;
  close(): void;
}

export interface GlimpseModuleAdapter {
  open(
    html: string,
    options: {
      width: number;
      height: number;
      title: string;
      noDock: boolean;
      openLinks: boolean;
    },
  ): GlimpseWindowAdapter;
}

interface WindowMessage {
  readonly action: "refresh" | "close" | "open-artifact" | "quickdiff";
  readonly path?: string;
}

export interface MissionPresenter {
  open(ctx: ExtensionContext, activeTokens: ReadonlySet<string>): Promise<void>;
  refresh(activeTokens: ReadonlySet<string>): Promise<void>;
  close(): void;
}

export function createMissionPresenter(
  store: MissionStore,
  projections = new ProjectionRegistry(),
  loadGlimpse: () => Promise<GlimpseModuleAdapter> = loadInstalledGlimpse,
): MissionPresenter & { readonly projections: ProjectionRegistry } {
  let window: GlimpseWindowAdapter | undefined;
  let tokens = new Set<string>();
  let sessionId: string | undefined;
  let extensionContext: ExtensionContext | undefined;
  let refreshTimer: ReturnType<typeof setInterval> | undefined;
  let refreshing = false;

  const pushSnapshot = async (): Promise<void> => {
    const targetWindow = window;
    const targetSessionId = sessionId;
    const targetTokens = new Set(tokens);
    if (!targetWindow || !targetSessionId || refreshing) return;
    refreshing = true;
    try {
      const mission = await runMission(store.snapshot(targetTokens));
      const projection = await projections.snapshot(
        mission.contexts,
        mission.receipts,
        targetSessionId,
      );
      const primary = mission.contexts.find(
        (context) => context.source === "session",
      );
      const totalTasks = projection.tasks.length;
      const completedTasks = projection.tasks.filter(
        (task) => task.status === "completed",
      ).length;
      const childContexts = mission.contexts.filter(
        (context) => context.source !== "session",
      );
      const completedChildren = childContexts.filter((context) =>
        ["completed", "failed", "cancelled"].includes(context.status),
      ).length;
      const denominator = totalTasks || childContexts.length;
      const numerator = totalTasks ? completedTasks : completedChildren;
      const snapshot = {
        mission: {
          title: primary?.title ?? "Mission Control",
          status: childContexts.some((context) => context.status === "active")
            ? "active"
            : "settled",
          progress:
            denominator === 0 ? 0 : Math.round((numerator / denominator) * 100),
          completed: numerator,
          total: denominator,
        },
        contexts: mission.contexts,
        receipts: mission.receipts,
        projection,
        updatedAt: new Date().toISOString(),
      };
      if (window === targetWindow) {
        targetWindow.send(`window.updateMission(${JSON.stringify(snapshot)})`);
      }
    } catch (error) {
      extensionContext?.ui.notify(
        `Mission Control refresh failed: ${error instanceof Error ? error.message : String(error)}`,
        "warning",
      );
    } finally {
      refreshing = false;
    }
  };

  const handleMessage = async (
    sourceWindow: GlimpseWindowAdapter,
    value: unknown,
  ): Promise<void> => {
    if (window !== sourceWindow) return;
    const message = parseWindowMessage(value);
    if (!message) return;
    if (message.action === "close") {
      const closingTimer = refreshTimer;
      window = undefined;
      extensionContext = undefined;
      refreshTimer = undefined;
      if (closingTimer) clearInterval(closingTimer);
      sourceWindow.close();
      return;
    }
    if (message.action === "refresh") {
      await pushSnapshot();
      return;
    }
    if (!message.path || !isArtifactPath(message.path, store.paths.artifacts))
      return;
    if (message.action === "quickdiff") openQuickdiff(message.path);
    else openArtifact(message.path);
  };

  return {
    projections,
    async open(ctx, activeTokens): Promise<void> {
      tokens = new Set(activeTokens);
      sessionId = ctx.sessionManager.getSessionId();
      extensionContext = ctx;
      if (window) {
        window.send("window.focus(); window.glimpseFocus?.()");
        await pushSnapshot();
        return;
      }
      const glimpse = await loadGlimpse();
      const openedWindow = glimpse.open(missionWindowHtml(), {
        width: 1060,
        height: 760,
        title: "Mission Control",
        noDock: true,
        openLinks: true,
      });
      window = openedWindow;
      const openedTimer = setInterval(() => void pushSnapshot(), 1_000);
      refreshTimer = openedTimer;
      openedTimer.unref();
      openedWindow.on("ready", () => {
        if (window === openedWindow) void pushSnapshot();
      });
      openedWindow.on(
        "message",
        (message) => void handleMessage(openedWindow, message),
      );
      openedWindow.on("error", (error) => {
        if (window !== openedWindow) return;
        extensionContext?.ui.notify(
          `Mission Control window failed: ${error.message}`,
          "warning",
        );
        window = undefined;
        extensionContext = undefined;
        clearInterval(openedTimer);
        if (refreshTimer === openedTimer) refreshTimer = undefined;
        openedWindow.close();
      });
      openedWindow.on("closed", () => {
        clearInterval(openedTimer);
        if (window !== openedWindow) return;
        window = undefined;
        extensionContext = undefined;
        if (refreshTimer === openedTimer) refreshTimer = undefined;
      });
    },
    async refresh(activeTokens): Promise<void> {
      tokens = new Set(activeTokens);
      await pushSnapshot();
    },
    close(): void {
      const closingWindow = window;
      const closingTimer = refreshTimer;
      window = undefined;
      extensionContext = undefined;
      refreshTimer = undefined;
      if (closingTimer) clearInterval(closingTimer);
      closingWindow?.close();
    },
  };
}

function parseWindowMessage(value: unknown): WindowMessage | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return undefined;
  const record = value as Record<string, unknown>;
  if (
    record.action !== "refresh" &&
    record.action !== "close" &&
    record.action !== "open-artifact" &&
    record.action !== "quickdiff"
  ) {
    return undefined;
  }
  return {
    action: record.action,
    ...defined(
      "path",
      typeof record.path === "string" ? record.path : undefined,
    ),
  };
}

async function loadInstalledGlimpse(): Promise<GlimpseModuleAdapter> {
  const moduleUrl = import.meta.resolve("glimpseui");
  const loaded: unknown = await import(moduleUrl);
  if (!isGlimpseModule(loaded)) throw new Error("Invalid Glimpse installation");
  return loaded;
}

function isGlimpseModule(value: unknown): value is GlimpseModuleAdapter {
  return (
    typeof value === "object" &&
    value !== null &&
    "open" in value &&
    typeof value.open === "function"
  );
}

function isArtifactPath(candidate: string, artifactsRoot: string): boolean {
  const relative = path.relative(
    path.resolve(artifactsRoot),
    path.resolve(candidate),
  );
  return (
    relative.length > 0 &&
    !relative.startsWith("..") &&
    !path.isAbsolute(relative)
  );
}

function openArtifact(filePath: string): void {
  if (process.platform === "darwin") {
    detached("open", [filePath]);
  } else if (process.platform === "win32") {
    detached("cmd", ["/c", "start", "", filePath]);
  } else {
    detached("xdg-open", [filePath]);
  }
}

function openQuickdiff(filePath: string): void {
  const command = `quickdiff --stdin < ${shellQuote(filePath)}`;
  if (process.platform === "darwin") {
    const script = `tell application "Terminal" to do script ${JSON.stringify(command)}`;
    detached("osascript", ["-e", script]);
  } else if (process.platform === "win32") {
    detached("cmd", [
      "/c",
      "start",
      "powershell",
      "-NoExit",
      "-Command",
      command,
    ]);
  } else {
    detached("x-terminal-emulator", ["-e", "sh", "-lc", command]);
  }
}

function detached(command: string, args: readonly string[]): void {
  const child = spawn(command, [...args], {
    detached: true,
    stdio: "ignore",
  });
  child.on("error", () => {});
  child.unref();
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function defined<Key extends string, Value>(
  key: Key,
  value: Value | undefined,
): { [Property in Key]?: Value } {
  return value === undefined
    ? {}
    : ({ [key]: value } as { [Property in Key]: Value });
}

function missionWindowHtml(): string {
  return String.raw`<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<meta name="color-scheme" content="light dark" />
<style>
  :root { --bg:#f4f5f7; --panel:#fff; --panel2:#f8f9fb; --text:#16181d; --muted:#707680; --line:#e4e7eb; --accent:#2864dc; --green:#1b8f5a; --amber:#c47a08; --red:#c73d4d; --shadow:0 10px 35px rgba(20,30,50,.09); }
  @media (prefers-color-scheme: dark) { :root { --bg:#111318; --panel:#191c22; --panel2:#20242c; --text:#f2f4f7; --muted:#9ca3af; --line:#303640; --accent:#6e9cff; --green:#4bc487; --amber:#efad42; --red:#f06c79; --shadow:0 14px 45px rgba(0,0,0,.28); } }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--text); font:13px/1.42 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; overflow:hidden; }
  button { font:inherit; }
  .app { height:100vh; display:grid; grid-template-rows:64px 1fr; }
  header { display:flex; align-items:center; gap:14px; padding:0 22px; background:color-mix(in srgb,var(--panel) 92%,transparent); border-bottom:1px solid var(--line); }
  .mark { width:30px; height:30px; border-radius:9px; display:grid; place-items:center; background:linear-gradient(145deg,#5d8cff,#2755c8); color:white; font-weight:800; box-shadow:0 5px 14px rgba(45,91,210,.28); }
  .head-copy { min-width:0; flex:1; }
  h1 { font-size:15px; margin:0; font-weight:680; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .sub { margin-top:2px; color:var(--muted); font-size:11px; }
  .live { display:flex; align-items:center; gap:7px; color:var(--muted); font-size:11px; }
  .live-dot { width:7px; height:7px; border-radius:50%; background:var(--green); box-shadow:0 0 0 4px color-mix(in srgb,var(--green) 15%,transparent); }
  .icon-btn { width:30px; height:30px; border:1px solid var(--line); border-radius:8px; background:var(--panel2); color:var(--muted); cursor:pointer; }
  main { padding:18px; min-height:0; display:grid; grid-template-columns:minmax(310px,39%) 1fr; gap:16px; }
  .column { min-height:0; display:flex; flex-direction:column; gap:14px; }
  .card { background:var(--panel); border:1px solid var(--line); border-radius:13px; box-shadow:var(--shadow); min-height:0; }
  .summary { padding:18px; }
  .summary-top { display:flex; justify-content:space-between; align-items:flex-end; margin-bottom:12px; }
  .eyebrow { color:var(--muted); text-transform:uppercase; letter-spacing:.08em; font-size:10px; font-weight:700; }
  .percent { font-size:28px; font-weight:720; letter-spacing:-.04em; }
  .bar { height:7px; border-radius:99px; background:var(--panel2); overflow:hidden; border:1px solid var(--line); }
  .bar > i { display:block; height:100%; background:linear-gradient(90deg,var(--accent),#6d94ec); transition:width .35s ease; }
  .summary-meta { display:flex; justify-content:space-between; color:var(--muted); font-size:11px; margin-top:9px; }
  .section { display:flex; flex-direction:column; overflow:hidden; }
  .section-head { height:43px; flex:none; display:flex; align-items:center; justify-content:space-between; padding:0 15px; border-bottom:1px solid var(--line); }
  .section-title { font-size:12px; font-weight:680; }
  .count { color:var(--muted); font-size:10px; padding:2px 7px; border-radius:99px; background:var(--panel2); }
  .scroll { overflow:auto; min-height:0; padding:7px; }
  .roadmap { flex:1; }
  .row { display:flex; gap:10px; align-items:flex-start; padding:9px 8px; border-radius:8px; }
  .row:hover { background:var(--panel2); }
  .state { margin-top:3px; width:9px; height:9px; border-radius:50%; border:2px solid var(--muted); flex:none; }
  .state.completed,.state.done { background:var(--green); border-color:var(--green); }
  .state.in_progress,.state.running,.state.active { background:var(--amber); border-color:var(--amber); }
  .state.failed,.state.error,.state.cancelled,.state.aborted { background:var(--red); border-color:var(--red); }
  .row-main { min-width:0; flex:1; }
  .row-title { font-weight:590; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .row-meta { margin-top:2px; color:var(--muted); font-size:10px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .right-grid { min-height:0; display:grid; grid-template-rows:minmax(180px,36%) 1fr; gap:14px; }
  .execution-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(210px,1fr)); gap:8px; padding:8px; overflow:auto; }
  .execution { border:1px solid var(--line); border-radius:10px; padding:11px; background:var(--panel2); }
  .execution-top { display:flex; align-items:center; gap:8px; }
  .chip { margin-left:auto; padding:2px 7px; border-radius:99px; font-size:9px; text-transform:uppercase; letter-spacing:.05em; color:var(--muted); border:1px solid var(--line); }
  .execution p { color:var(--muted); font-size:10px; margin:8px 0 0; max-height:30px; overflow:hidden; }
  .evidence-item { padding:11px 10px; border-bottom:1px solid var(--line); }
  .evidence-item:last-child { border-bottom:0; }
  .evidence-head { display:flex; align-items:center; gap:9px; }
  .evidence-title { font-weight:600; min-width:0; flex:1; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .time { color:var(--muted); font-size:10px; }
  .artifacts { display:flex; flex-wrap:wrap; gap:6px; margin:8px 0 0 18px; }
  .artifact { border:1px solid var(--line); background:var(--panel2); color:var(--text); border-radius:7px; padding:4px 8px; cursor:pointer; font-size:10px; }
  .artifact:hover { border-color:var(--accent); color:var(--accent); }
  .empty { height:100%; min-height:80px; display:grid; place-items:center; color:var(--muted); text-align:center; padding:20px; }
  .tabs { display:flex; gap:2px; padding:5px; background:var(--panel2); border-radius:9px; }
  .tab { border:0; background:transparent; color:var(--muted); padding:5px 9px; border-radius:6px; cursor:pointer; font-size:10px; }
  .tab.active { background:var(--panel); color:var(--text); box-shadow:0 1px 5px rgba(0,0,0,.08); }
  ::-webkit-scrollbar { width:8px; height:8px; } ::-webkit-scrollbar-thumb { background:color-mix(in srgb,var(--muted) 25%,transparent); border-radius:8px; }
</style>
</head>
<body>
<div class="app">
  <header>
    <div class="mark">M</div><div class="head-copy"><h1 id="mission-title">Mission Control</h1><div class="sub" id="updated">Waiting for mission state…</div></div>
    <div class="live"><span class="live-dot"></span><span id="live-label">live</span></div>
    <button class="icon-btn" data-action="refresh" title="Refresh">↻</button><button class="icon-btn" data-action="close" title="Close">×</button>
  </header>
  <main>
    <div class="column">
      <section class="card summary"><div class="summary-top"><div><div class="eyebrow">Mission progress</div><div class="sub" id="progress-label">No roadmap yet</div></div><div class="percent" id="progress">0%</div></div><div class="bar"><i id="progress-bar" style="width:0%"></i></div><div class="summary-meta"><span id="progress-count">0 of 0 settled</span><span id="mission-status">active</span></div></section>
      <section class="card section roadmap"><div class="section-head"><span class="section-title">Roadmap</span><span class="count" id="roadmap-count">0</span></div><div class="scroll" id="roadmap"><div class="empty">Tasks and workflow phases appear here.</div></div></section>
    </div>
    <div class="right-grid">
      <section class="card section"><div class="section-head"><span class="section-title">Executions</span><span class="count" id="execution-count">0</span></div><div class="execution-grid" id="executions"><div class="empty">No child executions yet.</div></div></section>
      <section class="card section"><div class="section-head"><span class="section-title">Evidence</span><div class="tabs"><button class="tab active" data-filter="all">All</button><button class="tab" data-filter="artifacts">Artifacts</button><button class="tab" data-filter="failures">Failures</button></div></div><div class="scroll" id="evidence"><div class="empty">Durable evidence receipts appear here.</div></div></section>
    </div>
  </main>
</div>
<script>
let state=null, filter='all';
const esc=(v)=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const ago=(iso)=>{const s=Math.max(0,Math.round((Date.now()-Date.parse(iso))/1000));return s<60?s+'s ago':s<3600?Math.floor(s/60)+'m ago':Math.floor(s/3600)+'h ago'};
const send=(data)=>window.glimpse.send(data);
window.glimpseFocus=()=>document.body.focus();
window.updateMission=(next)=>{state=next;render()};
function render(){if(!state)return;const m=state.mission;document.getElementById('mission-title').textContent=m.title;document.getElementById('updated').textContent='Updated '+ago(state.updatedAt);document.getElementById('progress').textContent=m.progress+'%';document.getElementById('progress-bar').style.width=m.progress+'%';document.getElementById('progress-count').textContent=m.completed+' of '+m.total+' settled';document.getElementById('progress-label').textContent=m.total?'Execution roadmap':'Awaiting roadmap';document.getElementById('mission-status').textContent=m.status;renderRoadmap();renderExecutions();renderEvidence()}
function renderRoadmap(){const tasks=state.projection.tasks;const workflows=state.projection.workflows;const rows=[...tasks.map(t=>({state:t.status,title:'#'+t.id+' '+t.subject,meta:t.blockedBy.length?'Blocked by '+t.blockedBy.map(x=>'#'+x).join(', '):(t.owner?'Owner '+t.owner:'Task')})),...workflows.flatMap(w=>w.agents.map(a=>({state:a.state,title:a.label,meta:(a.phase||w.currentPhase||w.name)+' · '+w.runId})))];document.getElementById('roadmap-count').textContent=rows.length;document.getElementById('roadmap').innerHTML=rows.length?rows.map(r=>'<div class="row"><i class="state '+esc(r.state)+'"></i><div class="row-main"><div class="row-title">'+esc(r.title)+'</div><div class="row-meta">'+esc(r.meta)+'</div></div></div>').join(''):'<div class="empty">Tasks and workflow phases appear here.</div>'}
function renderExecutions(){const contexts=state.projection.agents;const workflows=state.projection.workflows;const cards=[...contexts.map(c=>({state:c.status,title:c.title,chip:c.source,detail:c.latestMilestone||'Context ready'})),...workflows.map(w=>({state:w.status,title:w.name,chip:'workflow',detail:(w.currentPhase||w.status)+' · '+w.agents.length+' agent(s)'}))];document.getElementById('execution-count').textContent=cards.length;document.getElementById('executions').innerHTML=cards.length?cards.map(c=>'<div class="execution"><div class="execution-top"><i class="state '+esc(c.state)+'"></i><strong class="row-title">'+esc(c.title)+'</strong><span class="chip">'+esc(c.chip)+'</span></div><p>'+esc(c.detail)+'</p></div>').join(''):'<div class="empty">No child executions yet.</div>'}
function renderEvidence(){let receipts=state.receipts;if(filter==='artifacts')receipts=receipts.filter(r=>r.artifacts.length);if(filter==='failures')receipts=receipts.filter(r=>r.milestone.state==='failed');document.getElementById('evidence').innerHTML=receipts.length?receipts.map(r=>{const buttons=r.artifacts.map(a=>'<button class="artifact" data-action="'+(a.mediaType==='text/x-diff'?'quickdiff':'open-artifact')+'" data-path="'+esc(a.path)+'">'+esc(a.label||a.role)+(a.mediaType==='text/x-diff'?' · Quickdiff':'')+'</button>').join('');return '<div class="evidence-item"><div class="evidence-head"><i class="state '+esc(r.milestone.state)+'"></i><div class="evidence-title">'+esc(r.milestone.title)+'</div><span class="chip">'+esc(r.milestone.kind)+'</span><span class="time">'+ago(r.milestone.occurredAt)+'</span></div>'+(buttons?'<div class="artifacts">'+buttons+'</div>':'')+'</div>'}).join(''):'<div class="empty">No evidence matches this view.</div>'}
document.addEventListener('click',e=>{const target=e.target.closest('[data-action],[data-filter]');if(!target)return;if(target.dataset.filter){filter=target.dataset.filter;document.querySelectorAll('.tab').forEach(t=>t.classList.toggle('active',t.dataset.filter===filter));renderEvidence();return}send({action:target.dataset.action,path:target.dataset.path})});
document.addEventListener('keydown',e=>{if(e.key==='Escape')send({action:'close'});if((e.metaKey||e.ctrlKey)&&e.key==='r'){e.preventDefault();send({action:'refresh'})}});
</script>
</body>
</html>`;
}
