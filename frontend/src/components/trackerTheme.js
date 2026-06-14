// Shared design system for the Price Tracker / Market Activity / Squad pages.
// All CSS is scoped under a `.spk` root so it can't leak into the rest of the app.

export const SPK_CSS = `
.spk{
  --bg:#0B0D11; --panel:#13161C; --card:#171B22; --card-2:#1B2129;
  --line:rgba(255,255,255,.07); --line-2:rgba(255,255,255,.11);
  --text:#E7E9ED; --text-2:#929AA6; --text-3:#5E6671;
  --amber:#F5A623; --amber-2:#FFBE52; --amber-soft:rgba(245,166,35,.12);
  --green:#33C27A; --green-2:#4FD894; --green-soft:rgba(51,194,122,.12);
  --blue:#5897F0; --blue-2:#79AEF6; --blue-soft:rgba(88,151,240,.12);
  --orange:#F08A3C; --orange-soft:rgba(240,138,60,.12);
  --r:14px;
  --shadow:0 1px 0 rgba(255,255,255,.03) inset, 0 22px 48px -28px rgba(0,0,0,.85);
  --ff:"Inter",system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
  font-family:var(--ff); color:var(--text); font-size:14px; line-height:1.55; -webkit-font-smoothing:antialiased;
}
.spk *{box-sizing:border-box}
.spk .tnum,.spk .px,.spk .sv,.spk .m-px,.spk .m-amt,.spk .rk{font-variant-numeric:tabular-nums}

.spk .panel{background:var(--panel);border:1px solid var(--line);border-radius:18px;padding:clamp(18px,2.4vw,30px);box-shadow:var(--shadow)}
.spk .page-head{display:flex;align-items:flex-start;gap:16px;flex-wrap:wrap;margin-bottom:24px}
.spk .page-head .ttl{display:flex;align-items:center;gap:11px;font-size:22px;font-weight:800;letter-spacing:-.4px}
.spk .page-head .ttl .hi{width:30px;height:30px;border-radius:9px;background:var(--amber-soft);display:grid;place-items:center;color:var(--amber-2);flex:0 0 auto}
.spk .page-head .ttl .hi svg{width:17px;height:17px}
.spk .page-head .sub{color:var(--text-3);font-size:13px;margin-top:5px}
.spk .page-head .right{margin-left:auto}
.spk .btn-refresh{display:inline-flex;align-items:center;gap:8px;background:var(--card);border:1px solid var(--line-2);color:var(--text-2);font-family:inherit;font-weight:600;font-size:13px;padding:9px 15px;border-radius:10px;cursor:pointer;transition:.15s}
.spk .btn-refresh:hover{background:var(--card-2);color:var(--text)}
.spk .btn-refresh svg{width:15px;height:15px}
.spk .panel-gap{margin-top:18px}

.spk .toggle-row{display:flex;align-items:center;gap:15px;background:var(--card);border:1px solid var(--line);border-radius:var(--r);padding:16px 18px;margin-bottom:22px}
.spk .switch{width:46px;height:26px;border-radius:20px;background:var(--amber);position:relative;flex:0 0 auto;cursor:pointer;transition:.2s}
.spk .switch::after{content:"";position:absolute;top:3px;left:23px;width:20px;height:20px;border-radius:50%;background:#fff;transition:.2s}
.spk .switch.off{background:#2a313b}.spk .switch.off::after{left:3px}
.spk .toggle-row .tt{font-weight:700;font-size:14px}
.spk .toggle-row .td{color:var(--text-3);font-size:12.5px;margin-top:2px}

.spk .stats{display:grid;gap:14px;margin-bottom:22px}
.spk .stats.s6{grid-template-columns:repeat(auto-fit,minmax(184px,1fr))}
.spk .stats.s5{grid-template-columns:repeat(auto-fit,minmax(208px,1fr))}
.spk .stat{display:flex;flex-direction:column;background:var(--card);border:1px solid var(--line);border-radius:var(--r);padding:16px 18px 0;position:relative;overflow:hidden;min-height:134px}
.spk .stat .sl{font-size:11px;letter-spacing:.7px;text-transform:uppercase;color:var(--text-3);font-weight:700}
.spk .stat .sv{font-size:26px;font-weight:800;letter-spacing:-.6px;margin-top:10px;line-height:1.05}
.spk .stat .ss{font-size:12px;color:var(--text-3);margin-top:6px;margin-bottom:14px}
.spk .stat.hl{background:linear-gradient(180deg,var(--amber-soft),transparent),var(--card);border-color:rgba(245,166,35,.3)}
.spk .stat .chart{margin:auto -18px 0;height:44px;pointer-events:none}
.spk .stat .chart svg{display:block;width:100%;height:100%}
.spk .blue{color:var(--blue-2)} .spk .green{color:var(--green-2)} .spk .amber{color:var(--amber-2)}
.spk .chg-up{color:var(--green-2);font-weight:600} .spk .chg-dn{color:var(--amber-2);font-weight:600}

.spk .insights{display:grid;gap:11px;margin-bottom:24px}
.spk .insight{display:flex;align-items:center;gap:13px;border-radius:var(--r);padding:14px 17px;font-size:13.5px;line-height:1.5;border:1px solid var(--line)}
.spk .insight .ii{width:30px;height:30px;border-radius:9px;display:grid;place-items:center;flex:0 0 auto}
.spk .insight .ii svg{width:16px;height:16px}
.spk .insight b{font-weight:700}
.spk .insight.g{background:var(--green-soft);border-color:rgba(51,194,122,.22)} .spk .insight.g .ii{background:rgba(51,194,122,.18);color:var(--green-2)}
.spk .insight.a{background:var(--amber-soft);border-color:rgba(245,166,35,.22)} .spk .insight.a .ii{background:rgba(245,166,35,.18);color:var(--amber-2)}
.spk .insight.o{background:var(--orange-soft);border-color:rgba(240,138,60,.22)} .spk .insight.o .ii{background:rgba(240,138,60,.18);color:var(--orange)}

.spk .depth{display:grid;grid-template-columns:1fr 1fr;gap:18px}
.spk .book{background:var(--card);border:1px solid var(--line);border-radius:var(--r);padding:18px 20px}
.spk .book h4{margin:0 0 14px;font-size:12px;letter-spacing:.8px;text-transform:uppercase;font-weight:700}
.spk .book.buy h4{color:var(--blue-2)} .spk .book.sell h4{color:var(--green-2)}
.spk .lvl{display:grid;grid-template-columns:34px 1fr auto;align-items:center;gap:12px;padding:8px 0}
.spk .lvl .rk{color:var(--text-3);font-size:12px;font-weight:600}
.spk .lvl .nm{font-size:13px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.spk .lvl .px{font-weight:700;font-size:14px}
.spk .lvl .track{grid-column:2 / 4;height:6px;border-radius:6px;background:#20262e;overflow:hidden;margin-top:6px}
.spk .lvl .track i{display:block;height:100%;border-radius:6px}
.spk .lvl.t-gold .nm{color:var(--amber-2)} .spk .lvl.t-silver .nm{color:#D6DBE2} .spk .lvl.t-bronze .nm{color:var(--orange)} .spk .lvl.t-normal .nm{color:var(--text-2)}
.spk .book.buy .track i{background:linear-gradient(90deg,rgba(88,151,240,.5),var(--blue))}
.spk .book.sell .track i{background:linear-gradient(90deg,rgba(51,194,122,.5),var(--green))}
.spk .book.buy .px{color:var(--blue-2)} .spk .book.sell .px{color:var(--green-2)}
.spk .hist{display:flex;align-items:flex-end;gap:5px;height:60px;margin-top:18px;padding-top:14px;border-top:1px solid var(--line)}
.spk .hist b{flex:1;border-radius:4px 4px 0 0;opacity:.85}
.spk .book.buy .hist b{background:var(--blue)} .spk .book.sell .hist b{background:var(--green)}
.spk .hist-ax{display:flex;justify-content:space-between;color:var(--text-3);font-size:11px;margin-top:8px}
.spk .hist-ax span:nth-child(2){color:var(--text-2)}

.spk .book-head{display:flex;align-items:flex-start;gap:12px;margin-bottom:6px;padding-bottom:14px;border-bottom:1px solid var(--line)}
.spk .book-head h4{margin:0;font-size:14px;letter-spacing:.2px;text-transform:none}
.spk .book-head .book-sub{display:block;color:var(--text-3);font-size:12px;font-weight:500;margin-top:3px;font-style:italic}
.spk .book-head .book-hint{margin-left:auto;color:var(--text-3);font-size:11.5px;text-align:right;max-width:150px;line-height:1.4}
.spk .mrow{display:grid;grid-template-columns:30px 1fr auto;gap:12px;align-items:center;padding:11px 6px;border-bottom:1px solid var(--line);border-radius:8px;transition:background .12s}
.spk .mrow:last-of-type{border-bottom:none}
.spk .mrow:hover{background:var(--card-2)}
.spk .m-rk{display:grid;place-items:center;width:26px;height:26px;border-radius:8px;background:#20262e;color:var(--text-2);font-size:11px;font-weight:700}
.spk .m-main{min-width:0}
.spk .m-top{display:flex;align-items:center;gap:8px}
.spk .m-dot{width:8px;height:8px;border-radius:50%;flex:0 0 auto;background:var(--text-3)}
.spk .m-nm{font-weight:600;font-size:13.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;cursor:pointer}
.spk .m-nm:hover{text-decoration:underline}
.spk .t-gold .m-nm{color:var(--amber-2)} .spk .t-silver .m-nm{color:#D6DBE2} .spk .t-bronze .m-nm{color:var(--orange)} .spk .t-normal .m-nm{color:var(--text)}
.spk .t-gold .m-dot{background:#F5C04E} .spk .t-silver .m-dot{background:#C7CDD6} .spk .t-bronze .m-dot{background:var(--orange)}
.spk .me-tag{font-size:9px;font-weight:800;letter-spacing:.5px;color:#06122a;background:var(--blue-2);border-radius:4px;padding:1px 5px}
.spk .copied{font-size:10px;font-weight:700;color:var(--green-2)}
.spk .star{background:none;border:none;color:var(--text-3);cursor:pointer;padding:2px;flex:0 0 auto;display:grid;place-items:center;transition:.15s}
.spk .star svg{width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:1.7;stroke-linejoin:round}
.spk .star:hover{color:var(--amber-2);transform:scale(1.18)}
.spk .star.on{color:var(--amber-2)} .spk .star.on svg{fill:currentColor}
.spk .m-sub{display:flex;align-items:center;gap:9px;margin-top:5px;font-size:11.5px;flex-wrap:wrap}
.spk .tier{font-size:10px;font-weight:800;letter-spacing:.4px;padding:1px 6px;border-radius:5px}
.spk .tier.gold{background:rgba(245,192,78,.16);color:#F5C04E} .spk .tier.silver{background:rgba(199,205,214,.14);color:#D6DBE2} .spk .tier.bronze{background:rgba(240,138,60,.16);color:var(--orange)} .spk .tier.normal{background:rgba(146,154,166,.14);color:var(--text-2)}
.spk .m-pct{color:var(--green-2);font-weight:600} .spk .m-trades{color:var(--text-3)}
.spk .m-right{text-align:right;white-space:nowrap}
.spk .m-px{font-weight:700;font-size:14.5px}
.spk .book.buy .m-px{color:var(--blue-2)} .spk .book.sell .m-px{color:var(--green-2)}
.spk .m-amt{color:var(--text-3);font-size:12px;margin-top:3px}
.spk .book-empty{color:var(--text-3);font-size:13px;text-align:center;padding:22px 0}

.spk .wl-chips{display:flex;flex-wrap:wrap;gap:8px;margin-top:14px}
.spk .wl-chip{display:inline-flex;align-items:center;gap:6px;background:var(--amber-soft);color:var(--amber-2);border:1px solid rgba(245,166,35,.3);padding:6px 8px 6px 13px;border-radius:20px;font-size:12.5px;font-weight:600}
.spk .wl-chip .pos{color:var(--text-3);font-weight:500}
.spk .wl-chip button{background:none;border:none;color:var(--amber-2);cursor:pointer;font-size:16px;line-height:1;opacity:.75;padding:0}
.spk .wl-chip button:hover{opacity:1}
.spk .footnote{color:var(--text-3);font-size:12px;margin-top:22px;text-align:center;line-height:1.6}

.spk .section-h{font-size:14px;font-weight:700;margin:4px 0 14px}
.spk .tbl-wrap{background:var(--card);border:1px solid var(--line);border-radius:var(--r);overflow:hidden}
.spk table{width:100%;border-collapse:collapse}
.spk thead th{text-align:right;font-size:11px;letter-spacing:.6px;text-transform:uppercase;color:var(--text-3);font-weight:700;padding:14px 18px;border-bottom:1px solid var(--line)}
.spk thead th.l{text-align:left}
.spk tbody td{padding:14px 18px;border-bottom:1px solid var(--line);font-size:13.5px;text-align:right;font-variant-numeric:tabular-nums}
.spk tbody td.l{text-align:left}
.spk tbody tr:last-child td{border-bottom:none}
.spk tbody tr{transition:background .12s}
.spk tbody tr:hover{background:var(--card-2)}
.spk .rank{display:inline-grid;place-items:center;width:24px;height:24px;border-radius:7px;background:#20262e;color:var(--text-2);font-size:12px;font-weight:700}
.spk tbody tr:nth-child(-n+3) .rank{background:var(--amber-soft);color:var(--amber-2)}
.spk .m-name{font-weight:600}
.spk .v-traded{color:var(--amber-2);font-weight:700}
.spk .v-bought,.spk .v-sold{color:var(--green-2)}
.spk .muted{color:var(--text-3)}
.spk .mini-spark{display:inline-block;width:54px;height:16px;vertical-align:middle}

.spk .track-row{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
.spk .pill-group{display:flex;gap:8px;flex-wrap:wrap}
.spk .fpill{display:inline-flex;align-items:center;gap:8px;padding:9px 15px;border-radius:10px;border:1px solid var(--line-2);background:var(--card);color:var(--text-2);font-family:inherit;font-weight:600;font-size:13px;cursor:pointer;transition:.15s}
.spk .fpill:hover{background:var(--card-2);color:var(--text)}
.spk .fpill.on{background:var(--amber-soft);border-color:rgba(245,166,35,.4);color:var(--amber-2)}
.spk .fpill .d{width:8px;height:8px;border-radius:50%}
.spk .d-gold{background:#F5C04E}.spk .d-silver{background:#C7CDD6}.spk .d-bronze{background:#C8804B}
.spk .searchbox{flex:1;min-width:230px;display:flex;align-items:center;gap:10px;background:var(--bg);border:1px solid var(--line-2);border-radius:11px;padding:11px 14px;color:var(--text-3)}
.spk .searchbox svg{width:17px;height:17px;flex:0 0 auto}
.spk .searchbox input{flex:1;background:none;border:none;outline:none;color:var(--text);font-family:inherit;font-size:14px}
.spk .divider{height:1px;background:var(--line);margin:22px 0}

.spk .bname{display:flex;align-items:center;gap:13px;flex-wrap:wrap}
.spk .bname .lab{font-weight:700;font-size:13.5px;flex:0 0 auto}
.spk .bname .ipw{flex:1;min-width:220px;display:flex;align-items:center;gap:8px;background:var(--bg);border:1px solid var(--line-2);border-radius:11px;padding:11px 14px}
.spk .bname .ipw input{flex:1;background:none;border:none;outline:none;color:var(--text);font-family:inherit;font-size:14px;font-weight:600}
.spk .bname .ipw .clr{color:var(--text-3);cursor:pointer;width:22px;height:22px;display:grid;place-items:center;border-radius:6px;flex:0 0 auto}
.spk .bname .ipw .clr:hover{background:var(--card-2);color:var(--text)}
.spk .btn-link{background:none;border:1px solid rgba(88,151,240,.4);color:var(--blue-2);font-family:inherit;font-weight:600;font-size:13px;padding:11px 16px;border-radius:11px;cursor:pointer;white-space:nowrap;transition:.15s}
.spk .btn-link:hover{background:var(--blue-soft)}
.spk .btn-link:disabled{opacity:.6;cursor:default}
.spk .ok-line{color:var(--green-2);font-size:12.5px;font-weight:600;margin-top:13px;display:flex;align-items:center;gap:6px}
.spk .note{color:var(--text-3);font-size:12.5px;margin-top:8px;line-height:1.55}
.spk .pos-line{color:var(--text-2);font-size:13px;margin-top:12px}
.spk .pos-line b{color:var(--text)}

.spk .wl-head{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.spk .wl-head .wt{display:flex;align-items:center;gap:9px;font-weight:700;font-size:15px}
.spk .wl-head .wt svg{width:18px;height:18px;color:var(--text-2)}
.spk .wl-count{background:var(--amber-soft);color:var(--amber-2);font-size:12px;font-weight:700;padding:2px 10px;border-radius:20px}
.spk .wl-head .wh{margin-left:auto;color:var(--text-3);font-size:12.5px;max-width:48ch;text-align:right}
.spk .empty-line{color:var(--text-3);font-size:13px;margin-top:16px;padding:18px;border:1px dashed var(--line-2);border-radius:var(--r);text-align:center;line-height:1.5}

.spk .panel-head{display:flex;align-items:center;gap:11px;margin-bottom:20px}
.spk .panel-head .ph-t{display:flex;align-items:center;gap:10px;font-size:16px;font-weight:700}
.spk .panel-head .ph-t svg{width:18px;height:18px;color:var(--amber-2)}
.spk .alerts-pill{margin-left:auto;display:inline-flex;align-items:center;gap:8px;background:var(--green-soft);color:var(--green-2);border:1px solid rgba(51,194,122,.25);padding:6px 13px;border-radius:20px;font-size:12.5px;font-weight:700;cursor:pointer;user-select:none}
.spk .alerts-pill svg{width:13px;height:13px}
.spk .alerts-body.collapsed{display:none}
.spk .chk{display:flex;align-items:center;gap:11px;padding:9px 0;font-size:14px;cursor:pointer}
.spk .chk input{width:18px;height:18px;accent-color:var(--amber);flex:0 0 auto;cursor:pointer}
.spk .tg-row{display:flex;align-items:center;gap:14px;flex-wrap:wrap;margin:8px 0 4px}
.spk .tg-ok{color:var(--green-2);font-size:13px;font-weight:600;display:flex;align-items:center;gap:6px}
.spk .tg-bad{color:var(--amber-2);font-size:13px;font-weight:600}
.spk .btn-soft{background:var(--card-2);border:1px solid var(--line-2);color:var(--text);font-family:inherit;font-weight:600;font-size:13px;padding:9px 15px;border-radius:10px;cursor:pointer;transition:.15s}
.spk .btn-soft:hover{background:#232a33}
.spk .btn-soft:disabled{opacity:.6;cursor:default}
.spk .flabel{font-size:11px;letter-spacing:.7px;text-transform:uppercase;color:var(--text-3);font-weight:700;margin:22px 0 9px}
.spk .grid-2{display:grid;grid-template-columns:1fr 1fr;gap:16px}
.spk .sel{width:100%;appearance:none;background:var(--bg);border:1px solid var(--line-2);border-radius:11px;color:var(--text);padding:12px 38px 12px 14px;font-family:inherit;font-size:14px;font-weight:500;cursor:pointer;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' fill='none' stroke='%23929AA6' stroke-width='2'%3E%3Cpath d='M2 4l4 4 4-4'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right 14px center;transition:.15s}
.spk .sel:focus{outline:none;border-color:var(--amber);box-shadow:0 0 0 3px var(--amber-soft)}
.spk .notify-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(310px,1fr));gap:0 30px}
.spk .margin-grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}
.spk .minp{width:100%;background:var(--bg);border:1px solid var(--line-2);border-radius:11px;padding:12px 14px;color:var(--text);font-family:inherit;font-size:15px;font-weight:700;outline:none;font-variant-numeric:tabular-nums;transition:.15s}
.spk .minp:focus{border-color:var(--amber);box-shadow:0 0 0 3px var(--amber-soft)}
.spk .btn-primary{background:linear-gradient(180deg,#7AAEF8,var(--blue));color:#06122a;border:none;border-radius:11px;padding:13px 26px;font-family:inherit;font-weight:700;font-size:14px;cursor:pointer;margin-top:22px;box-shadow:0 10px 24px -10px rgba(88,151,240,.6);transition:.15s}
.spk .btn-primary:hover{filter:brightness(1.06)}
.spk .btn-primary:disabled{opacity:.6;cursor:default}
.spk .save-msg{margin-left:14px;font-size:13px;font-weight:600;color:var(--green-2)}

.spk .sim-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:13px}
.spk .sim{background:var(--bg);border:1px solid var(--line);border-radius:var(--r);padding:15px 16px}
.spk .sim .sl{font-size:11px;letter-spacing:.6px;text-transform:uppercase;color:var(--text-3);font-weight:700}
.spk .sim .sv{font-size:22px;font-weight:800;margin-top:8px;letter-spacing:-.4px}
.spk .sim .sim-sub{font-size:11px;color:var(--text-3);margin-top:5px;line-height:1.4}

.spk .squad-card{background:var(--card);border:1px solid var(--line);border-radius:var(--r);padding:clamp(20px,3vw,30px)}
.spk .squad-card h3{margin:0 0 12px;font-size:18px;font-weight:700}
.spk .squad-card p{color:var(--text-2);font-size:14px;line-height:1.75;max-width:74ch;margin:0 0 22px}
.spk .squad-card p b{color:var(--text);font-weight:600}
.spk .squad-form{display:flex;gap:12px;flex-wrap:wrap}
.spk .squad-form input{flex:1;min-width:240px;background:var(--bg);border:1px solid var(--line-2);border-radius:11px;padding:14px 16px;color:var(--text);font-family:inherit;font-size:14.5px;outline:none;transition:.15s}
.spk .squad-form input::placeholder{color:var(--text-3)}
.spk .squad-form input:focus{border-color:var(--amber);box-shadow:0 0 0 3px var(--amber-soft)}
.spk .btn-create{background:linear-gradient(180deg,var(--amber-2),var(--amber));color:#1a1206;border:none;border-radius:11px;padding:14px 26px;font-family:inherit;font-weight:700;font-size:14.5px;cursor:pointer;white-space:nowrap;transition:.15s;box-shadow:0 10px 24px -10px rgba(245,166,35,.6)}
.spk .btn-create:hover{filter:brightness(1.06)}
.spk .btn-create:disabled{opacity:.6;cursor:default}
.spk .squad-features{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:13px;margin-top:26px}
.spk .feat{display:flex;gap:12px;align-items:flex-start;background:var(--bg);border:1px solid var(--line);border-radius:var(--r);padding:15px 16px}
.spk .feat .fi{width:30px;height:30px;border-radius:9px;background:var(--amber-soft);display:grid;place-items:center;color:var(--amber-2);flex:0 0 auto}
.spk .feat .fi svg{width:16px;height:16px}
.spk .feat .ft{font-weight:600;font-size:13.5px}
.spk .feat .fd{color:var(--text-3);font-size:12.5px;margin-top:2px;line-height:1.5}

.spk .mode-tag{font-size:11px;font-weight:800;padding:3px 10px;border-radius:7px;letter-spacing:.4px}
.spk .mode-off{background:rgba(255,255,255,.08);color:var(--text-2)}
.spk .mode-sim{background:var(--amber-soft);color:var(--amber-2)}
.spk .mode-live{background:var(--green-soft);color:var(--green-2)}
.spk .srow{display:grid;grid-template-columns:1.4fr 1fr .6fr .6fr .7fr .7fr;gap:10px;align-items:center;padding:11px 4px;border-bottom:1px solid var(--line);font-size:13px}
.spk .srow.head{color:var(--text-3);font-size:11px;letter-spacing:.4px;text-transform:uppercase;font-weight:700}
.spk .srow:last-child{border-bottom:none}
.spk .srow .r{text-align:right}
.spk .ok{color:var(--green-2);font-weight:700} .spk .bad{color:#ef6a7e;font-weight:700}
.spk .gate{font-size:12.5px;padding:.6rem .85rem;border-radius:10px;margin:6px 0;line-height:1.45}
.spk .gate.on{background:rgba(239,106,126,.08);border:1px solid rgba(239,106,126,.28);color:#f6c9d1}
.spk .gate.off{background:var(--green-soft);border:1px solid rgba(51,194,122,.25);color:#d6f5df}
.spk .invite-row{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;background:var(--amber-soft);border:1px solid rgba(245,166,35,.3);border-radius:11px;padding:12px 15px;font-size:13.5px;margin-bottom:10px}
.spk .invite-row .ib{display:flex;gap:8px}

@media(max-width:760px){
  .spk .depth{grid-template-columns:1fr}
  .spk .stat .sv{font-size:22px}
  .spk .wl-head .wh{margin-left:0;text-align:left}
  .spk .srow{grid-template-columns:1.4fr 1fr;gap:6px}
  .spk .srow .hide-sm{display:none}
  .spk thead{display:none}
  .spk table,.spk tbody,.spk tbody tr,.spk tbody td{display:block;width:100%}
  .spk tbody tr{padding:14px 16px;border-bottom:1px solid var(--line)}
  .spk tbody td{display:flex;justify-content:space-between;align-items:center;text-align:right;padding:5px 0;border:none;font-size:13.5px}
  .spk tbody td.l{text-align:left}
  .spk tbody td::before{content:attr(data-label);color:var(--text-3);font-size:11px;letter-spacing:.5px;text-transform:uppercase;font-weight:700;text-align:left}
  .spk tbody td.row-head{padding-bottom:10px;margin-bottom:6px;border-bottom:1px solid var(--line)}
  .spk tbody td.row-head::before{display:none}
}
@media(max-width:680px){.spk .grid-2,.spk .margin-grid{grid-template-columns:1fr}}
`;

// ── smooth Catmull-Rom sparklines (return SVG markup strings) ──
function smoothPath(p) {
  if (p.length < 2) return '';
  let d = 'M' + p[0][0].toFixed(1) + ',' + p[0][1].toFixed(1);
  for (let i = 0; i < p.length - 1; i++) {
    const a = p[i - 1] || p[i], b = p[i], c = p[i + 1], e = p[i + 2] || c;
    const c1x = b[0] + (c[0] - a[0]) / 6, c1y = b[1] + (c[1] - a[1]) / 6;
    const c2x = c[0] - (e[0] - b[0]) / 6, c2y = c[1] - (e[1] - b[1]) / 6;
    d += 'C' + c1x.toFixed(1) + ',' + c1y.toFixed(1) + ' ' + c2x.toFixed(1) + ',' + c2y.toFixed(1) + ' ' + c[0].toFixed(1) + ',' + c[1].toFixed(1);
  }
  return d;
}
let _sid = 0;
export function spark(data, color) {
  const d = (data || []).filter(v => v != null && !isNaN(v));
  if (d.length < 2) return '';
  const w = 120, h = 48, pad = 6, id = 'g' + (_sid++);
  const mx = Math.max(...d), mn = Math.min(...d), rng = (mx - mn) || 1;
  const pts = d.map((v, i) => [i / (d.length - 1) * w, h - pad - ((v - mn) / rng) * (h - pad * 2)]);
  const line = smoothPath(pts), area = line + `L${w},${h} L0,${h} Z`;
  return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none"><defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${color}" stop-opacity=".30"/><stop offset="1" stop-color="${color}" stop-opacity="0"/></linearGradient></defs><path d="${area}" fill="url(#${id})"/><path d="${line}" fill="none" stroke="${color}" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke"/></svg>`;
}
export function miniSpark(data, color) {
  const d = (data || []).filter(v => v != null && !isNaN(v));
  if (d.length < 2) return '';
  const w = 64, h = 20, pad = 3;
  const mx = Math.max(...d), mn = Math.min(...d), rng = (mx - mn) || 1;
  const pts = d.map((v, i) => [i / (d.length - 1) * w, h - pad - ((v - mn) / rng) * (h - pad * 2)]);
  return `<svg class="mini-spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none"><path d="${smoothPath(pts)}" fill="none" stroke="${color}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke"/></svg>`;
}

export const CVAR = { blue: '#5897F0', green: '#33C27A', amber: '#F5A623' };
