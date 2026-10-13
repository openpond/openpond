export const REPORT_STYLE = `
 .report-pagination{display:flex;align-items:center;justify-content:flex-end;gap:8px;padding:4px}.report-pagination button{font:inherit;background:transparent;color:var(--text);border:0;padding:4px}.report-pagination button:disabled{opacity:.4}
body{margin:0;color:var(--text);font:13px/1.5 var(--font-web)}
h2{font-size:16px;margin:0 0 12px}p,small{color:var(--muted)}
.experiment-report{border:1px solid var(--border);border-radius:8px;overflow:hidden}.report-tabs{display:flex;gap:3px;padding:0;background:var(--panel-soft)}
.report-tabs button{flex:0 0 auto;border:0;border-radius:5px;background:transparent;color:var(--muted);padding:4px 8px;font:inherit;font-size:12px;white-space:nowrap;cursor:pointer}
.report-tabs button:hover{color:var(--text)}
.report-tabs button[aria-selected="true"]{background:var(--panel);color:var(--text);box-shadow:inset 0 0 0 1px var(--border)}
.report-tabs button:focus-visible,[role="tabpanel"]:focus-visible{outline:2px solid var(--cyan);outline-offset:2px}
[role="tabpanel"]{padding-top:0}[hidden]{display:none!important}
.run-label small{display:block;font-weight:normal;overflow-wrap:anywhere}
table{width:100%;border-collapse:collapse;font-size:12px;text-align:left}
th,td{padding:5px 8px;border-bottom:1px solid var(--border);vertical-align:top;overflow-wrap:normal}
table.summary td{white-space:nowrap}table.summary th:first-child{min-width:140px}
table.summary td small{display:block;white-space:normal;max-width:100px}
table.cases{table-layout:fixed}table.cases td:nth-child(3){overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
thead{background:var(--panel-soft)}
.table-wrap{overflow:auto}
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
  root.querySelectorAll('.table-wrap').forEach(wrapper => {
    const rows = Array.from(wrapper.querySelectorAll('tbody tr'));
    if (rows.length <= 5) return;
    let page = 0;
    const controls = document.createElement('div');
    controls.className = 'report-pagination';
    const previous = document.createElement('button'); previous.textContent = 'Previous'; previous.type = 'button';
    const next = document.createElement('button'); next.textContent = 'Show more'; next.type = 'button';
    const label = document.createElement('span');
    function render() {
      rows.forEach((row, index) => { row.hidden = index < page * 5 || index >= (page + 1) * 5; });
      previous.disabled = page === 0; next.disabled = (page + 1) * 5 >= rows.length;
      label.textContent = (page + 1) + '/' + Math.ceil(rows.length / 5);
    }
    previous.addEventListener('click', () => { page--; render(); });
    next.addEventListener('click', () => { page++; render(); });
    controls.append(previous, label, next); wrapper.append(controls); render();
  });
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
