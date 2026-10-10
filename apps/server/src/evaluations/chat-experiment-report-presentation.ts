export const REPORT_STYLE = `
body{margin:0;color:var(--text);font:13px/1.5 var(--font-web)}
h2{font-size:16px;margin:0 0 12px}p,small{color:var(--muted)}
.report-tabs{display:flex;gap:3px;padding:3px;border:1px solid var(--border);border-radius:8px;background:var(--panel-soft)}
.report-tabs button{flex:1;border:0;border-radius:5px;background:transparent;color:var(--muted);padding:9px 10px;font:inherit;font-size:12px;white-space:nowrap;cursor:pointer}
.report-tabs button:hover{color:var(--text)}
.report-tabs button[aria-selected="true"]{background:var(--panel);color:var(--text);box-shadow:inset 0 0 0 1px var(--border)}
.report-tabs button:focus-visible,[role="tabpanel"]:focus-visible{outline:2px solid var(--cyan);outline-offset:2px}
[role="tabpanel"]{padding-top:4px}[hidden]{display:none!important}
.run-label small{display:block;font-weight:normal;overflow-wrap:anywhere}
table{width:100%;border-collapse:collapse;font-size:12px;text-align:left}
th,td{padding:9px 12px;border-bottom:1px solid var(--border);vertical-align:top;overflow-wrap:normal}
table.summary td{white-space:nowrap}table.summary th:first-child{min-width:140px}
table.summary td small{display:block;white-space:normal;max-width:100px}
table.cases{min-width:600px}table.cases td:nth-child(3){min-width:260px;overflow-wrap:anywhere}
thead{background:var(--panel-soft)}
.table-wrap{overflow:auto;border:1px solid var(--border);border-radius:8px}
.chart{display:grid;gap:12px;margin:20px 0}
.bar-row{display:grid;grid-template-columns:minmax(100px,1fr) minmax(80px,2fr) 80px;align-items:center;gap:10px}
.track{height:24px;background:var(--panel-soft);border-radius:4px}
.bar{height:100%;background:var(--cyan);border-radius:4px}
.track span{padding-left:8px;color:var(--muted)}
ul{padding-left:18px;font-size:11px;overflow-wrap:anywhere}li+li{margin-top:12px}
@media(max-width:420px){.bar-row{grid-template-columns:1fr 1fr 70px}th,td{padding:7px}}
`;

// Fixed presentation behavior only: retained output never enters executable code.
// Each HTML visual owns its isolated document; handlers stay within this report.
export const REPORT_TABS_SCRIPT = `(() => {
  const root = document.currentScript.previousElementSibling;
  const tabs = Array.from(root.querySelectorAll('[role="tab"]'));
  const panels = Array.from(root.querySelectorAll('[role="tabpanel"]'));
  function select(index, focus) {
    tabs.forEach((tab, i) => {
      tab.setAttribute('aria-selected', String(i === index));
      tab.tabIndex = i === index ? 0 : -1;
      panels[i].hidden = i !== index;
    });
    if (focus) tabs[index].focus();
  }
  tabs.forEach((tab, index) => {
    tab.addEventListener('click', () => select(index, false));
    tab.addEventListener('keydown', event => {
      let next;
      if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
      else if (event.key === 'ArrowLeft') next = (index + tabs.length - 1) % tabs.length;
      else if (event.key === 'Home') next = 0;
      else if (event.key === 'End') next = tabs.length - 1;
      else return;
      event.preventDefault();
      select(next, true);
    });
  });
})();`;
