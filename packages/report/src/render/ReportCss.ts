// The report's one stylesheet, inlined in a <style> element. No fonts, images or URLs. Text
// colours have at least 4.5:1 contrast on their backgrounds; the accessibility checks verify
// this on the rendered output.
export const REPORT_CSS = `
:root{--ink:#1b1b1b;--muted:#4f4f4f;--line:#c9ced6;--paper:#ffffff;--soft:#f3f5f8;--p1:#a50e0e;--p2:#a85200;--p3:#1a5fb4;--p4:#4a4a4a;--rv:#5b3a8c;--ok:#0b5d1e;--focus:#0b57d0}
*{box-sizing:border-box}
html{font-size:100%}
body{margin:0;background:var(--paper);color:var(--ink);font:1rem/1.45 system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif}
a{color:#0b4cb3;text-underline-offset:2px}
a:focus-visible{outline:3px solid var(--focus);outline-offset:2px}
.skip{position:absolute;left:.5rem;top:-6rem;background:#fff;color:#000;padding:.5rem .75rem;border:2px solid #000;z-index:5}
.skip:focus{top:.5rem}
header.top{display:flex;flex-wrap:wrap;gap:.25rem 1.5rem;align-items:center;justify-content:space-between;padding:.5rem 1rem;border-bottom:1px solid var(--line);background:var(--soft)}
header.top p{margin:0}
.brand{font-weight:700}
.brand small{font-weight:400;color:var(--muted)}
header.top ul{display:flex;flex-wrap:wrap;gap:.25rem 1rem;margin:0;padding:0;list-style:none}
main{max-width:1240px;margin:0 auto;padding:0 1rem 2rem}
h1{font-size:1.5rem;line-height:1.2;margin:.25rem 0}
h2{font-size:1.3rem;margin:2rem 0 .5rem;border-bottom:2px solid var(--ink);padding-bottom:.2rem}
h3{font-size:1.05rem;margin:.25rem 0}
h4{font-size:.9rem;margin:.5rem 0 .2rem}
p{margin:.35rem 0}
.muted{color:var(--muted)}
.banner{margin:1rem 0;padding:.75rem 1rem;border:3px solid var(--ink);border-radius:6px}
.banner.v-failed{background:#fdeeee;border-color:var(--p1)}
.banner.v-needs-review{background:#fff4dc;border-color:var(--p2)}
.banner.v-passed{background:#e8f5ec;border-color:var(--ok)}
.kicker{margin:0;font-size:.85rem;color:var(--muted);text-transform:uppercase;letter-spacing:.04em}
.verdict{display:flex;flex-wrap:wrap;gap:.25rem 1rem;align-items:baseline;margin:.25rem 0}
.vword{font-size:1.9rem;font-weight:800;letter-spacing:.02em}
.v-failed .vword{color:#8a0b0b}.v-needs-review .vword{color:#6b3600}.v-passed .vword{color:#0b4d1a}
.counts{display:flex;flex-wrap:wrap;gap:.5rem 1.5rem;margin:.25rem 0 0;padding:0;list-style:none;font-size:1.1rem}
.counts strong{font-size:1.5rem}
.sev{display:inline-block;white-space:nowrap;min-width:2.2rem;padding:0 .35rem;border-radius:3px;color:#fff;font-weight:700;font-size:.85rem;text-align:center;border:2px solid #fff;outline:1px solid currentColor}
.sev-P1{background:var(--p1);outline-color:var(--p1)}.sev-P2{background:var(--p2);outline-color:var(--p2)}.sev-P3{background:var(--p3);outline-color:var(--p3)}.sev-P4{background:var(--p4);outline-color:var(--p4)}.sev-none{background:var(--rv);outline-color:var(--rv)}
.top-grid{display:grid;grid-template-columns:minmax(0,3fr) minmax(0,2fr);gap:1rem;align-items:start}
@media (max-width:760px){.top-grid{grid-template-columns:minmax(0,1fr)}}
figure{margin:0}
figcaption{font-size:.9rem;color:var(--muted);margin-top:.25rem}
svg.shot{display:block;width:100%;height:auto;border:1px solid var(--line);background:#fff}
ol.callouts{margin:0;padding:0;list-style:none;display:grid;gap:.4rem}
ol.callouts li{display:flex;gap:.5rem;align-items:baseline}
.num{display:inline-block;min-width:1.7rem;text-align:center;font-weight:800;border:2px solid var(--ink);border-radius:50%;padding:0 .2rem;line-height:1.4}
.pl{font-size:.8rem;color:var(--muted)}
.gallery{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,420px),1fr));gap:1.25rem}
table{border-collapse:collapse;width:100%;font-size:.9rem}
th,td{border:1px solid var(--line);padding:.25rem .4rem;text-align:left;vertical-align:top;overflow-wrap:anywhere}
thead th{background:var(--soft)}
tbody th{font-weight:600}
.card{border:1px solid var(--line);border-left:6px solid var(--ink);border-radius:4px;padding:.5rem .75rem;margin:.75rem 0;break-inside:avoid}
.card.c-P1{border-left-color:var(--p1)}.card.c-P2{border-left-color:var(--p2)}.card.c-P3{border-left-color:var(--p3)}.card.c-P4{border-left-color:var(--p4)}.card.c-none{border-left-color:var(--rv)}.n{white-space:nowrap}
.kv{display:grid;grid-template-columns:minmax(7rem,12rem) minmax(0,1fr);gap:.15rem .75rem;margin:.15rem 0}
.kv>div{overflow-wrap:anywhere}
.cap{margin:.75rem 0 .25rem;font-weight:700}
.card ol{margin:.15rem 0;padding-left:1.4rem}
.ex{margin:.5rem 0;border:1px solid var(--line);border-radius:4px;padding:.25rem .5rem;background:var(--soft)}
.pair{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,300px),1fr));gap:.5rem}
pre{margin:0;white-space:pre-wrap;overflow-wrap:anywhere;font:.82rem/1.35 ui-monospace,Consolas,"Courier New",monospace}
.strip{display:flex;flex-wrap:wrap;gap:3px;margin:.25rem 0 .75rem;padding:0;list-style:none}
.strip a,.strip .cell{display:flex;align-items:center;justify-content:center;width:26px;height:26px;border:2px solid var(--ink);border-radius:3px;font-weight:800;text-decoration:none;background:#fff;color:var(--ink)}
.strip .st-failed a{background:#fdeeee;border-color:var(--p1);color:#8a0b0b}.strip .st-needs-review a{background:#fff4dc;border-color:var(--p2);border-style:dashed;color:#6b3600}.strip .st-passed .cell{background:#e8f5ec;border-color:var(--ok);color:#0b4d1a}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,190px),1fr));gap:.6rem;margin:.5rem 0}
.tile{border:1px solid var(--line);border-radius:4px;padding:.4rem .6rem;background:var(--soft)}
.tile b{display:block;font-size:1.5rem}
.demo{display:inline-block;margin:.25rem 0;padding:.15rem .5rem;border:2px dashed var(--rv);color:#3d2468;font-weight:700;background:#f3eefb}
ol.ladder{display:flex;flex-wrap:wrap;gap:.3rem;margin:.5rem 0;padding:0;list-style:none}
ol.ladder li{border:2px solid var(--line);border-radius:4px;padding:.15rem .5rem;font-size:.9rem}
ol.ladder li[aria-current]{border-color:var(--ink);background:#fff4dc;font-weight:800}
svg.chart{display:block;width:100%;height:auto;max-width:720px;border:1px solid var(--line);background:#fff}
.legend{display:grid;gap:.25rem;margin:.5rem 0;padding:0;list-style:none}
footer{max-width:1240px;margin:0 auto;padding:1rem;border-top:1px solid var(--line);font-size:.9rem}
@media print{.skip,header.top ul{display:none}}
`.trim();
