/** Single-file admin page. No build step, no external assets. */
export const PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>cloakroom admin</title>
<style>
  :root { --bg:#0f1115; --panel:#181b22; --line:#2a2f3a; --text:#e6e9ef; --dim:#9aa3b2;
          --accent:#5b9dd9; --ok:#4caf7d; --warn:#d9a05b; }
  * { box-sizing:border-box; }
  body { margin:0; font:14px/1.45 system-ui, sans-serif; background:var(--bg); color:var(--text); }
  header { padding:14px 20px; border-bottom:1px solid var(--line); display:flex; gap:14px; align-items:center; }
  header h1 { font-size:16px; margin:0; }
  header .meta { color:var(--dim); font-size:12px; }
  main { display:flex; height:calc(100vh - 57px); }
  #left { width:380px; border-right:1px solid var(--line); overflow-y:auto; padding:12px; }
  #right { flex:1; overflow-y:auto; padding:20px; }
  input, select, button { background:var(--panel); color:var(--text); border:1px solid var(--line);
          border-radius:6px; padding:6px 9px; font:inherit; }
  button { cursor:pointer; } button:hover { border-color:var(--accent); }
  button.primary { background:var(--accent); color:#0b0d10; border-color:var(--accent); font-weight:600; }
  button:disabled { opacity:.45; cursor:not-allowed; }
  #search { width:100%; margin-bottom:8px; }
  .tbl { color:var(--dim); font-size:11px; text-transform:uppercase; letter-spacing:.06em; margin:14px 0 4px; }
  .col { padding:5px 8px; border-radius:6px; cursor:pointer; display:flex; gap:8px; align-items:center; }
  .col:hover { background:var(--panel); }
  .col.active { background:var(--panel); outline:1px solid var(--accent); }
  .col .dt { color:var(--dim); font-size:11px; margin-left:auto; }
  .badge { font-size:10px; padding:1px 7px; border-radius:9px; border:1px solid; white-space:nowrap; }
  .badge.tagged { color:var(--ok); border-color:var(--ok); }
  .badge.sugg { color:var(--warn); border-color:var(--warn); }
  table { border-collapse:collapse; width:100%; margin-top:10px; }
  th, td { text-align:left; padding:6px 10px; border-bottom:1px solid var(--line); }
  th { color:var(--dim); font-weight:500; font-size:12px; }
  td input[type=text] { width:100%; }
  .row { display:flex; gap:10px; align-items:center; margin:10px 0; flex-wrap:wrap; }
  .hint { color:var(--dim); font-size:12px; }
  .tok { color:var(--ok); font-family:ui-monospace, monospace; }
  .excl { color:var(--warn); }
  .auto { color:var(--dim); font-style:italic; }
  #msg { position:fixed; bottom:14px; right:14px; background:var(--panel); border:1px solid var(--line);
         padding:9px 14px; border-radius:8px; display:none; max-width:420px; }
  #err { position:fixed; top:0; left:0; right:0; background:#7a2030; color:#fff; padding:8px 14px;
         z-index:99; font:13px ui-monospace, monospace; display:none; }
</style>
</head>
<body>
<div id="err"></div>
<header>
  <h1>cloakroom</h1>
  <span id="model-slot"></span>
  <button id="view-toggle" title="Browse every token / real value mapping">Mappings</button>
  <span class="meta" id="state"></span>
</header>
<main>
  <div id="left">
    <input id="search" placeholder="Filter columns... (e.g. name, DimCompany)">
    <div id="cols"><div class="hint">Loading schema...</div></div>
  </div>
  <div id="right"><div class="hint">Select a column to review samples and configure masking.
    Columns flagged <span class="badge sugg">suggested</span> look sensitive by name.
    This page shows real values — it is served on 127.0.0.1 only.</div></div>
</main>
<div id="msg"></div>
<script>
"use strict";
var UI_VERSION = "0.3.1";
window.onerror = function(message, source, line){
  var b = document.getElementById("err");
  if (b) { b.textContent = "cloakroom ui error: " + message + " (line " + line + ") — please report this"; b.style.display = "block"; }
};
console.log("[cloakroom ui] v" + UI_VERSION + " loaded");

var columns = [], current = null, filterText = "", mappingsView = false;

function el(id) { return document.getElementById(id); }
function esc(s) { var d = document.createElement("div"); d.textContent = String(s); return d.innerHTML; }
function msg(t) { var m = el("msg"); m.textContent = t; m.style.display = "block";
  setTimeout(function(){ m.style.display = "none"; }, 3200); }
function api(path, opts) {
  opts = opts || {};
  opts.headers = opts.headers || {};
  opts.headers["x-cloakroom"] = "1";
  return fetch(path, opts).then(function(r){
    return r.json().then(function(j){ if (!r.ok) throw new Error(j.error || r.status); return j; });
  });
}

/* ---------- header: state line ---------- */
function loadState() {
  api("/api/state").then(function(s){
    el("state").textContent = "v" + UI_VERSION + " · " + s.adapter +
      (s.connection ? " · " + s.connection : "") +
      " · " + s.tokenMode + " tokens · " + s.storeCount + " mappings · " +
      s.rules.length + " rules · " + s.configPath;
  }).catch(function(){ /* state line is cosmetic */ });
}

/* ---------- header: model switcher (only with 2+ models) ---------- */
var lastModelsJson = "";
function loadModels() {
  api("/api/models").then(function(d){
    var j = JSON.stringify(d.models || []);
    if (j === lastModelsJson) return; // unchanged — keep dropdown state
    lastModelsJson = j;
    el("model-slot").innerHTML = "";
    if (!d.models || d.models.length < 2) return;
    var sel = document.createElement("select");
    d.models.forEach(function(m){
      var o = document.createElement("option");
      o.value = m; o.textContent = m;
      if (d.current && m.toLowerCase().indexOf(String(d.current).toLowerCase()) >= 0) o.selected = true;
      sel.appendChild(o);
    });
    sel.onchange = function(){
      el("right").innerHTML = '<div class="hint">Connecting to ' + esc(sel.value) + '...</div>';
      api("/api/connect", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: sel.value }) })
      .then(function(r){
        msg(r.connection);
        current = null;
        loadState();
        loadColumns();
        el("right").innerHTML = '<div class="hint">Connected. Select a column.</div>';
      })
      .catch(function(e){ msg("Error: " + e.message); });
    };
    var slot = el("model-slot");
    slot.innerHTML = "";
    slot.appendChild(sel);
  }).catch(function(){ /* no switcher on error */ });
}

/* ---------- left: column list ---------- */
function renderColumns() {
  var byTable = {};
  var f = filterText.toLowerCase();
  columns.forEach(function(c){
    if (f && c.key.toLowerCase().indexOf(f) < 0) return;
    (byTable[c.table] = byTable[c.table] || []).push(c);
  });
  var h = "";
  var tables = Object.keys(byTable).sort();
  if (tables.length === 0) h = '<div class="hint">No columns match.</div>';
  tables.forEach(function(t){
    h += '<div class="tbl">' + esc(t) + '</div>';
    byTable[t].forEach(function(c){
      var badge = c.tagged ? '<span class="badge tagged">tagged</span>'
                : (c.suggested ? '<span class="badge sugg">suggested</span>' : '');
      var active = current && current.key === c.key ? " active" : "";
      h += '<div class="col' + active + '" data-key="' + esc(c.key) + '">' + esc(c.column) + badge +
           '<span class="dt">' + esc(c.dataType || "") + '</span></div>';
    });
  });
  el("cols").innerHTML = h;
  var nodes = document.querySelectorAll(".col");
  for (var i = 0; i < nodes.length; i++) {
    (function(node){ node.onclick = function(){ select(node.getAttribute("data-key")); }; })(nodes[i]);
  }
}

function loadColumns() {
  return api("/api/columns").then(function(cols){
    columns = cols;
    renderColumns();
  }).catch(function(e){ el("cols").innerHTML = '<div class="hint">Schema discovery failed: ' + esc(e.message) + '</div>'; });
}

/* ---------- right: column detail ---------- */
function select(key) {
  var c = columns.filter(function(x){ return x.key === key; })[0];
  if (!c) return;
  current = c;
  if (mappingsView) { mappingsView = false; el("view-toggle").textContent = "Mappings"; }
  renderColumns();
  el("right").innerHTML = '<div class="hint">Sampling ' + esc(key) + '...</div>';
  api("/api/column?table=" + encodeURIComponent(c.table) + "&column=" + encodeURIComponent(c.column))
    .then(function(d){ renderDetail(c, d); })
    .catch(function(e){ el("right").innerHTML = '<div class="hint">Sampling failed: ' + esc(e.message) + '</div>'; });
}

function isExcluded(value, excludeList) {
  var v = value.toLowerCase();
  return excludeList.some(function(x){ return x.toLowerCase() === v; });
}

function renderDetail(c, d) {
  var rule = d.rule || { match: c.key, mask: "token", prefix: guessPrefix(c.column), exclude: [] };
  var exclude = rule.exclude || [];
  var over = d.distinctCount !== undefined && d.distinctCount > d.sampleLimit;
  var h = '<h2 style="margin:0 0 2px">' + esc(c.key) + '</h2>' +
    '<div class="hint">' + (d.distinctCount !== undefined ? d.distinctCount + " distinct values" : "distinct count unavailable") +
    (over ? ' · showing first ' + d.sampleLimit + ' — the rest are tokenized automatically' : '') + '</div>' +
    '<div class="row">' +
      '<label>mask <select id="f-mask"><option value="token"' + (rule.mask==="token"?" selected":"") + '>token</option>' +
      '<option value="email"' + (rule.mask==="email"?" selected":"") + '>email</option></select></label>' +
      '<label>prefix <input type="text" id="f-prefix" value="' + esc(rule.prefix) + '" size="10"></label>' +
      '<label>exclude <input type="text" id="f-exclude" value="' + esc(exclude.join(", ")) + '" size="22" ' +
        'placeholder="UNKNOWN, N/A" title="Comma-separated values that must never be masked"></label>' +
      '<button class="primary" id="f-save">' + (d.rule ? "Update rule" : "Mark as sensitive") + '</button>' +
      (d.rule ? '<button id="f-remove">Remove rule</button>' : '') +
      (c.suggested ? '<button id="f-dismiss" title="Hide the suggested badge for this column">Not sensitive</button>' : '') +
      (c.dismissed ? '<span class="hint">suggestion dismissed</span><button id="f-undismiss">Restore</button>' : '') +
    '</div>' +
    '<div class="hint">Assign custom tokens below or leave blank for automatic numbering. ' +
    'Tick <b>skip</b> for placeholder values that should pass through unmasked.</div>';
  h += '<table><tr><th>real value</th><th>agent sees</th><th>custom token</th><th>skip</th></tr>';
  d.values.forEach(function(v){
    var excluded = isExcluded(v.value, exclude);
    var sees = excluded ? '<span class="excl">' + esc(v.value) + ' (excluded)</span>'
             : v.token ? '<span class="tok">' + esc(v.token) + '</span>'
             : '<span class="auto">auto-token on first query</span>';
    h += '<tr><td>' + esc(v.value) + '</td><td>' + sees + '</td>' +
         '<td><input type="text" class="tok-in" data-value="' + esc(v.value) + '" placeholder="(auto)" value="' +
         esc(v.token || "") + '"' + (excluded ? " disabled" : "") + '></td>' +
         '<td><input type="checkbox" class="excl-in" data-value="' + esc(v.value) + '"' +
         (excluded ? " checked" : "") + '></td></tr>';
  });
  h += '</table><div class="row">' +
       '<button class="primary" id="f-apply"' + (d.rule ? "" : " disabled") + '>Apply mappings</button>' +
       '<span class="hint">' + (d.rule ? "Tokens must be unique. Blank = next automatic token." :
         "Save the rule first, then apply mappings.") + '</span></div>';
  el("right").innerHTML = h;

  el("f-save").onclick = function(){ saveRule(c, false); };
  if (el("f-remove")) el("f-remove").onclick = function(){ saveRule(c, true); };
  if (el("f-dismiss")) el("f-dismiss").onclick = function(){ dismiss(c, false); };
  if (el("f-undismiss")) el("f-undismiss").onclick = function(){ dismiss(c, true); };
  el("f-apply").onclick = function(){ applyMappings(c); };
  var boxes = document.querySelectorAll(".excl-in");
  for (var i = 0; i < boxes.length; i++) {
    (function(cb){
      cb.onchange = function(){
        var list = el("f-exclude").value.split(",").map(function(s){ return s.trim(); }).filter(Boolean);
        var v = cb.getAttribute("data-value");
        if (cb.checked) { if (!isExcluded(v, list)) list.push(v); }
        else { list = list.filter(function(x){ return x.toLowerCase() !== v.toLowerCase(); }); }
        el("f-exclude").value = list.join(", ");
        msg(cb.checked ? 'Will exclude "' + v + '" — save the rule to apply' : 'Removed exclusion — save the rule to apply');
      };
    })(boxes[i]);
  }
}

function guessPrefix(name) {
  var n = name.toLowerCase();
  if (n.indexOf("company") >= 0 || n.indexOf("trading") >= 0) return "Company";
  if (n.indexOf("client") >= 0 || n.indexOf("customer") >= 0) return "Client";
  if (n.indexOf("email") >= 0) return "Email";
  if (n.indexOf("phone") >= 0 || n.indexOf("mobile") >= 0) return "Phone";
  if (n.indexOf("name") >= 0) return "Person";
  return "Value";
}

function saveRule(c, remove) {
  var exclude = el("f-exclude").value.split(",").map(function(s){ return s.trim(); }).filter(Boolean);
  api("/api/rule", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ match: c.key, mask: el("f-mask").value, prefix: el("f-prefix").value,
      exclude: exclude, remove: remove }) })
  .then(function(r){
    msg(remove ? "Rule removed" : (r.warmup === "started" ? "Rule saved — scanning column values…" : "Rule saved"));
    loadState();
    return loadColumns().then(function(){ select(c.key); }); })
  .catch(function(e){ msg("Error: " + e.message); });
}

function applyMappings(c) {
  var assignments = [];
  var inputs = document.querySelectorAll(".tok-in");
  for (var i = 0; i < inputs.length; i++) {
    if (inputs[i].disabled) continue;
    assignments.push({ value: inputs[i].getAttribute("data-value"), token: inputs[i].value });
  }
  api("/api/mappings", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ match: c.key, assignments: assignments }) })
  .then(function(r){ msg("Applied " + r.applied + " mappings (" + r.storeCount + " total)"); loadState(); select(c.key); })
  .catch(function(e){ msg("Error: " + e.message); });
}

function dismiss(c, undo) {
  api("/api/dismiss", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ key: c.key, undo: undo }) })
  .then(function(){ msg(undo ? "Suggestion restored" : "Marked as not sensitive");
    return loadColumns().then(function(){ select(c.key); }); })
  .catch(function(e){ msg("Error: " + e.message); });
}

/* ---------- right: mappings browser ---------- */
function showMappings() {
  el("right").innerHTML = '<div class="hint">Loading mappings...</div>';
  api("/api/mappings-list").then(function(d){
    el("right").innerHTML = '<h2 style="margin:0 0 2px">Token mappings</h2>' +
      '<div class="hint">' + d.total + ' mappings · search by token, real value, or column</div>' +
      '<div class="row"><input type="text" id="map-search" placeholder="search token, real value, or column" style="width:380px"></div>' +
      '<div id="map-table"></div>';
    var rows = d.mappings;
    function render(filter){
      var f = (filter || "").toLowerCase();
      var shown = 0, max = 500;
      var t = '<table><tr><th>token</th><th>real value</th><th>column</th></tr>';
      for (var i = 0; i < rows.length && shown < max; i++) {
        var r = rows[i];
        if (f && r.token.toLowerCase().indexOf(f) < 0 && r.value.toLowerCase().indexOf(f) < 0 &&
            r.group.toLowerCase().indexOf(f) < 0) continue;
        t += '<tr><td class="tok">' + esc(r.token) + '</td><td>' + esc(r.value) + '</td>' +
             '<td class="hint">' + esc(r.group) + '</td></tr>';
        shown++;
      }
      t += '</table>';
      if (shown === 0) t = '<div class="hint" style="margin-top:10px">No mappings match.</div>';
      else if (shown === max) t += '<div class="hint">Showing first ' + max + ' — refine your search.</div>';
      el("map-table").innerHTML = t;
    }
    render("");
    el("map-search").oninput = function(){ render(el("map-search").value.trim()); };
    el("map-search").focus();
  }).catch(function(e){ el("right").innerHTML = '<div class="hint">Failed: ' + esc(e.message) + '</div>'; });
}

/* ---------- wiring ---------- */
el("view-toggle").onclick = function(){
  mappingsView = !mappingsView;
  el("view-toggle").textContent = mappingsView ? "Columns" : "Mappings";
  if (mappingsView) showMappings();
  else {
    el("right").innerHTML = '<div class="hint">Select a column to review samples and configure masking.</div>';
    if (current) select(current.key);
  }
};

el("search").oninput = function(){ filterText = el("search").value; renderColumns(); };

loadState();
loadModels();
loadColumns();
setInterval(loadModels, 15000); // pick up newly opened Power BI files
</script>
</body>
</html>`;
