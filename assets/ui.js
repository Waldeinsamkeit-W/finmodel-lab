/* ============================================================================
 * ui.js —— 路由、渲染与交互
 * ==========================================================================*/
(function () {
  'use strict';

  const DB = window.DB;
  const Store = window.Store;
  const FML = window.FML;
  const $app = document.getElementById('app');
  const $toast = document.getElementById('toast');

  const LEVELS = { 1: { name: '简单', cls: 'lv1' }, 2: { name: '中级', cls: 'lv2' }, 3: { name: '复杂', cls: 'lv3' } };
  const MARKETS = { primary: { name: '一级市场', cls: 'mkt-primary' }, secondary: { name: '二级市场', cls: 'mkt-secondary' } };

  /* ------------------------------------------------------------- 小工具 */
  const byId = (arr, id) => arr.filter((x) => x.id === id)[0] || null;
  const esc = (s) => String(s === undefined || s === null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const el = (html) => { const d = document.createElement('div'); d.innerHTML = html.trim(); return d.firstElementChild; };

  function toast(msg, kind, ms) {
    $toast.textContent = msg;
    $toast.className = 'toast show' + (kind ? ' ' + kind : '');
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { $toast.className = 'toast'; }, ms || 2200);
  }

  function grp(s) {
    const neg = s[0] === '-';
    if (neg) s = s.slice(1);
    const parts = s.split('.');
    parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return (neg ? '-' : '') + parts.join('.');
  }

  function fmtVal(v, fmt) {
    if (v === '' || v === null || v === undefined) return '';
    if (typeof v === 'string') return v;
    if (typeof v !== 'number' || !isFinite(v)) return '—';
    switch (fmt) {
      case 'pct0': return (v * 100).toFixed(0) + '%';
      case 'pct1': return (v * 100).toFixed(1) + '%';
      case 'pct2': return (v * 100).toFixed(2) + '%';
      case 'num0': return grp(v.toFixed(0));
      case 'num1': return grp(v.toFixed(1));
      case 'num2': return grp(v.toFixed(2));
      case 'num3': return grp(v.toFixed(3));
      case 'num4': return grp(v.toFixed(4));
      default: {
        const a = Math.abs(v);
        if (a >= 1000) return grp(v.toFixed(0));
        if (a >= 100) return grp(v.toFixed(1));
        if (a >= 1) return grp(v.toFixed(2));
        if (a === 0) return '0';
        return v.toFixed(4);
      }
    }
  }

  function timeAgo(ts) {
    if (!ts) return '';
    const d = Date.now() - ts;
    if (d < 60000) return '刚刚';
    if (d < 3600000) return Math.floor(d / 60000) + ' 分钟前';
    if (d < 86400000) return Math.floor(d / 3600000) + ' 小时前';
    if (d < 86400000 * 30) return Math.floor(d / 86400000) + ' 天前';
    const dt = new Date(ts);
    return dt.getFullYear() + '-' + String(dt.getMonth() + 1).padStart(2, '0') + '-' + String(dt.getDate()).padStart(2, '0');
  }
  function fullTime(ts) {
    if (!ts) return '—';
    const d = new Date(ts);
    const p = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  function companyOf(m) { return m.companyId ? byId(DB.companies, m.companyId) : null; }
  function industryOf(x) { return x && x.industryId ? byId(DB.industries, x.industryId) : (x && x.industry ? byId(DB.industries, x.industry) : null); }
  function modelsOfCompany(cid) { return DB.models.filter((m) => m.companyId === cid); }
  function modelsOfIndustry(iid) { return DB.models.filter((m) => m.industryId === iid); }

  function countInputs(model) {
    let n = 0;
    model.sheets.forEach((s) => s.rows.forEach((r) => (r.cells || []).forEach((c) => { if (c && c.kind === 'input') n++; })));
    return n;
  }

  /* =========================================================================
   * 工作簿构建
   * =======================================================================*/
  /* 取值函数统一由引擎提供（严格版：引用不到会报错，而不是悄悄当成 0） */
  function makeGetter(model, inputs, useSolution) {
    return FML.makeGetter(model, inputs, useSolution);
  }

  function cellFmt(sheet, row, cell) { return (cell && cell.fmt) || row.fmt || undefined; }

  function nearEnough(a, b) {
    if (typeof a !== 'number' || typeof b !== 'number') return false;
    if (!isFinite(a) || !isFinite(b)) return false;
    return Math.abs(a - b) <= Math.max(1e-6, Math.abs(b) * 0.002);
  }

  /* =========================================================================
   * 应用状态
   * =======================================================================*/
  const S = {
    filterMarket: 'all', filterLevel: 'all', filterIndustry: 'all',
    model: null, sheetIdx: 0, actInfo: null, inputs: {}, wb: null, sol: null,
    showChecks: false, hintFor: null, startTs: 0
  };

  /* =========================================================================
   * 路由
   * =======================================================================*/
  function go(hash) { window.location.hash = hash; }
  function parseRoute() {
    const h = (window.location.hash || '#/').replace(/^#/, '');
    const parts = h.split('/').filter(Boolean);
    return { name: parts[0] || 'home', arg: parts[1] ? decodeURIComponent(parts[1]) : null };
  }

  function render() {
    closeDrawer();
    if (S.model && S.startTs) { Store.addSeconds(S.model.id, Math.round((Date.now() - S.startTs) / 1000)); S.startTs = 0; }
    const r = parseRoute();
    S.model = null; S.actInfo = null; S.hintFor = null;
    window.scrollTo(0, 0);
    switch (r.name) {
      case 'model': return viewModel(r.arg);
      case 'company': return viewCompany(r.arg);
      case 'industry': return viewIndustry(r.arg);
      case 'path': return shell(viewPath());
      case 'courses': return shell(viewCourses());
      case 'type': return viewType(r.arg);
      case 'browse': return shell(viewBrowse(r.arg));
      case 'progress': return shell(viewProgress());
      case 'about': return shell(viewAbout());
      case 'board': return shell(viewBoard());
      default: return shell(viewHome());
    }
  }

  /* =========================================================================
   * 外壳（侧边栏 + 内容）
   * =======================================================================*/
  function shell(contentHTML) {
    const r = parseRoute();
    const sum = Store.summary();
    const total = DB.models.length;
    const nav = [
      { h: '#/', ico: '◈', t: '总览', on: r.name === 'home' },
      { h: '#/path', ico: '➜', t: '学习路径', cnt: (DB.path || []).reduce(function (a, s2) { return a + s2.steps.length; }, 0), on: r.name === 'path' },
      { h: '#/courses', ico: '◎', t: '按模型分类', cnt: (DB.modelTypes || []).length, on: r.name === 'courses' || r.name === 'type' },
      { h: '#/browse/all', ico: '▤', t: '全部模型', cnt: total, on: r.name === 'browse' && r.arg === 'all' },
      { h: '#/browse/secondary', ico: '↗', t: '二级市场', cnt: DB.models.filter((m) => m.market === 'secondary').length, on: r.name === 'browse' && r.arg === 'secondary' },
      { h: '#/browse/primary', ico: '◆', t: '一级市场', cnt: DB.models.filter((m) => m.market === 'primary').length, on: r.name === 'browse' && r.arg === 'primary' },
      { h: '#/progress', ico: '◔', t: '我的进度', on: r.name === 'progress' },
      { h: '#/about', ico: '?', t: '使用说明', on: r.name === 'about' }
    ];
    const inds = DB.industries.map((i) =>
      '<a class="nav-item' + (r.name === 'industry' && r.arg === i.id ? ' active' : '') + '" href="#/industry/' + i.id + '">' +
      '<span class="ico" style="color:' + i.color + '">●</span>' + esc(i.name) +
      '<span class="cnt">' + modelsOfIndustry(i.id).length + '</span></a>').join('');

    const navTitle = (nav.filter(function (n) { return n.on; })[0] || {}).t || 'FinModel Lab';
    $app.innerHTML =
      '<div class="mobile-bar">' +
        '<button class="mb-burger" id="mbBurger" aria-label="打开菜单">☰</button>' +
        '<div class="mb-title">' + esc(navTitle) + '</div>' +
      '</div>' +
      '<aside class="sidebar" id="sideNav">' +
        '<a class="brand" href="#/" style="text-decoration:none;color:inherit">' +
          '<div class="brand-mark">FM</div>' +
          '<div class="brand-text"><b>FinModel Lab</b><span>财务模型实训</span></div>' +
        '</a>' +
        nav.map((n) => '<a class="nav-item' + (n.on ? ' active' : '') + '" href="' + n.h + '"><span class="ico">' + n.ico + '</span>' + n.t +
          (n.cnt !== undefined ? '<span class="cnt">' + n.cnt + '</span>' : '') + '</a>').join('') +
        '<div class="nav-label">按行业</div>' + inds +
        '<div class="sidebar-foot">' +
          '<div class="progress-line" style="margin-bottom:8px"><span>完成 ' + sum.completed + '/' + total + '</span></div>' +
          '<div class="bar"><i style="width:' + (total ? Math.round(sum.completed / total * 100) : 0) + '%"></i></div>' +
          accountBlock(r) +
          '<button class="nav-item" id="themeBtn" style="margin-top:6px"><span class="ico">◐</span>切换深浅色</button>' +
        '</div>' +
      '</aside>' +
      '<main class="main"><div class="container">' + contentHTML + '</div></main>';

    const tb = document.getElementById('themeBtn');
    if (tb) tb.onclick = toggleTheme;
    bindDrawer();
    bindAccount();
    bindCards();
  }

  /* =========================================================================
   * 账号（没配 config.js 时整块不出现，站点行为和以前完全一样）
   * =======================================================================*/
  function accountBlock(r) {
    if (!window.Auth || !Auth.enabled()) return '';
    const u = Auth.user(), p = Auth.profile();
    if (!u) {
      return '<button class="nav-item" id="btnLogin" style="margin-top:12px">' +
        '<span class="ico">◌</span>登录 / 注册</button>' +
        '<div style="font-size:11px;color:var(--ink-3);padding:2px 10px 0;line-height:1.5">不登录也能练，进度存在这台设备上</div>';
    }
    const name = (p && p.nickname) || (u.email || '').split('@')[0];
    return '<div style="margin-top:12px">' +
      (Auth.isAdmin() ? '<a class="nav-item' + (r.name === 'board' ? ' active' : '') + '" href="#/board"><span class="ico">▩</span>班级看板</a>' : '') +
      '<div class="nav-item" style="cursor:default"><span class="ico">●</span>' +
        '<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(name) + '</span>' +
        '<button class="btn ghost sm" id="btnLogout" style="margin-left:auto;padding:2px 6px">退出</button>' +
      '</div>' +
      '<div id="syncHint" style="font-size:11px;color:var(--ink-3);padding:0 10px;line-height:1.5">进度已同步到云端</div>' +
    '</div>';
  }

  function bindAccount() {
    const a = document.getElementById('btnLogin');
    if (a) a.onclick = showAuthModal;
    const b = document.getElementById('btnLogout');
    if (b) b.onclick = function () {
      if (!confirm('退出登录？本地进度会保留在这台设备上。')) return;
      Auth.signOut().then(function () { toast('已退出'); render(); });
    };
  }

  function showAuthModal(mode) {
    mode = mode === 'signup' ? 'signup' : 'login';
    const wrap = document.createElement('div');
    wrap.className = 'modal-mask';
    function html() {
      const signup = mode === 'signup';
      return '<div class="modal" style="max-width:400px">' +
        '<div class="mh"><h2 style="margin-bottom:2px">' + (signup ? '注册' : '登录') + '</h2>' +
          '<div style="font-size:12.5px;color:var(--ink-3)">登录后进度会同步到云端，换设备也能接着练</div></div>' +
        '<div class="mb">' +
          (signup ? '<label style="display:block;font-size:12px;color:var(--ink-2);margin-bottom:4px">昵称</label>' +
            '<input id="auNick" class="fx-input" style="width:100%;border:1px solid var(--border-strong);border-radius:8px;margin-bottom:12px;padding:8px 10px;font-family:var(--sans)" placeholder="别人在看板上看到的名字" maxlength="24">' : '') +
          '<label style="display:block;font-size:12px;color:var(--ink-2);margin-bottom:4px">邮箱</label>' +
          '<input id="auMail" type="email" autocomplete="username" class="fx-input" style="width:100%;border:1px solid var(--border-strong);border-radius:8px;margin-bottom:12px;padding:8px 10px;font-family:var(--sans)">' +
          '<label style="display:block;font-size:12px;color:var(--ink-2);margin-bottom:4px">密码' + (signup ? '（至少 6 位）' : '') + '</label>' +
          '<input id="auPass" type="password" autocomplete="' + (signup ? 'new-password' : 'current-password') + '" class="fx-input" style="width:100%;border:1px solid var(--border-strong);border-radius:8px;padding:8px 10px;font-family:var(--sans)">' +
          '<div id="auMsg" style="font-size:12.5px;color:var(--err);margin-top:10px;min-height:18px;line-height:1.5"></div>' +
          '<div style="font-size:11.5px;color:var(--ink-3);margin-top:8px;line-height:1.6">' +
            '只收邮箱和昵称，用于登录与同步进度。' + (signup ? '' : '<a href="#" id="auForgot">忘记密码</a>') + '</div>' +
        '</div>' +
        '<div class="mf">' +
          '<button class="btn ghost" id="auSwitch">' + (signup ? '已有账号，去登录' : '还没有账号，去注册') + '</button>' +
          '<button class="btn primary" id="auGo">' + (signup ? '注册' : '登录') + '</button>' +
        '</div>' +
      '</div>';
    }
    function mount() {
      wrap.innerHTML = html();
      const msg = wrap.querySelector('#auMsg');
      const go = wrap.querySelector('#auGo');
      wrap.querySelector('#auSwitch').onclick = function () { mode = mode === 'signup' ? 'login' : 'signup'; mount(); };
      const forgot = wrap.querySelector('#auForgot');
      if (forgot) forgot.onclick = function (e) {
        e.preventDefault();
        const em = wrap.querySelector('#auMail').value.trim();
        if (!em) { msg.textContent = '先填邮箱，再点忘记密码'; return; }
        Auth.resetPassword(em)
          .then(function () { msg.style.color = 'var(--ok)'; msg.textContent = '重置邮件已发出，去邮箱看看'; })
          .catch(function (e2) { msg.style.color = 'var(--err)'; msg.textContent = e2.message; });
      };
      go.onclick = function () {
        const em = wrap.querySelector('#auMail').value.trim();
        const pw = wrap.querySelector('#auPass').value;
        const nk = mode === 'signup' ? wrap.querySelector('#auNick').value.trim() : '';
        msg.style.color = 'var(--err)';
        if (!em || !pw) { msg.textContent = '邮箱和密码都要填'; return; }
        if (mode === 'signup' && !nk) { msg.textContent = '起个昵称吧'; return; }
        if (mode === 'signup' && pw.length < 6) { msg.textContent = '密码至少 6 位'; return; }
        go.disabled = true; msg.textContent = '';
        const act = mode === 'signup' ? Auth.signUp(em, pw, nk) : Auth.signIn(em, pw);
        act.then(function (res) {
          if (mode === 'signup' && res && res.signedIn === false) {
            msg.style.color = 'var(--ok)';
            msg.textContent = '注册成功。去邮箱点一下验证链接，然后回来登录。';
            go.disabled = false;
            return;
          }
          wrap.remove();
          toast('已登录，正在同步进度…');
          return Sync.pullAndMerge().then(function (stat) {
            render();
            if (stat && stat.首次上传) toast('本地进度已上传到云端', 'ok');
            else if (stat && (stat.用了云端.length || stat.新增.length)) {
              toast('已合并：云端取回 ' + (stat.用了云端.length + stat.新增.length) + ' 个模型，本地保留 ' + stat.用了本地.length + ' 个', 'ok', 6000);
            } else toast('进度已同步', 'ok');
          });
        }).catch(function (e) {
          msg.textContent = e.message; go.disabled = false;
        });
      };
      wrap.querySelector('#auMail').focus();
    }
    wrap.onclick = function (e) { if (e.target === wrap) wrap.remove(); };
    document.body.appendChild(wrap);
    mount();
  }

  /* =========================================================================
   * 班级看板（管理员）—— 能不能读到别人的数据由数据库策略决定，不是这里判断的
   * =======================================================================*/
  function viewBoard() {
    setTimeout(function () {
      const host = document.getElementById('boardBody');
      if (!host) return;
      Auth.loadClassBoard().then(function (rows) {
        if (!rows || !rows.length) { host.innerHTML = '<div class="empty">还没有人注册。</div>'; return; }
        const totalCells = DB.models.reduce(function (a, m) { return a + countInputs(m); }, 0);
        host.innerHTML =
          '<table class="kv-table"><thead><tr>' +
            '<th>昵称</th><th>邮箱</th><th>已开始</th><th>已完成</th><th>答对格</th><th>用时</th><th>最后活跃</th>' +
          '</tr></thead><tbody>' +
          rows.map(function (x) {
            const pr = x.profiles || {};
            return '<tr>' +
              '<td>' + esc(pr.nickname || '—') + '</td>' +
              '<td style="font-size:12px;color:var(--ink-3)">' + esc(pr.email || '—') + '</td>' +
              '<td class="n">' + (x.models_started || 0) + '</td>' +
              '<td class="n">' + (x.models_completed || 0) + ' / ' + DB.models.length + '</td>' +
              '<td class="n">' + (x.correct_cells || 0) + ' / ' + totalCells + '</td>' +
              '<td class="n">' + Math.round((x.total_seconds || 0) / 60) + ' 分钟</td>' +
              '<td style="font-size:12px">' + timeAgo(new Date(x.updated_at).getTime()) + '</td>' +
            '</tr>';
          }).join('') +
          '</tbody></table>';
      }).catch(function (e) {
        host.innerHTML = '<div class="empty">读不到数据：' + esc(e.message) +
          '<div style="font-size:12px;margin-top:8px">如果提示权限相关，检查一下你的账号是不是设成了 is_admin。</div></div>';
      });
    }, 0);

    return '<div class="page-head"><div class="eyebrow">管理</div><h1>班级看板</h1>' +
      '<div class="sub">每个登录过的学员的进度。数据由数据库的行级安全策略保护——只有管理员账号读得到这张表。</div></div>' +
      '<div class="card pad" id="boardBody"><div class="empty">加载中…</div></div>';
  }

  /* ------------------------------------------------------------ 移动端抽屉 */
  function isNarrow() { return window.innerWidth <= 860; }

  function closeDrawer() {
    const sn = document.getElementById('sideNav');
    if (sn) sn.classList.remove('open');
    const bd = document.getElementById('navBackdrop');
    if (bd) bd.remove();
  }

  function bindDrawer() {
    const b = document.getElementById('mbBurger');
    const sn = document.getElementById('sideNav');
    if (!b || !sn) return;
    b.onclick = function () {
      const open = sn.classList.toggle('open');
      if (open) {
        const bd = document.createElement('div');
        bd.className = 'nav-backdrop';
        bd.id = 'navBackdrop';
        bd.onclick = closeDrawer;
        document.body.appendChild(bd);
      } else closeDrawer();
    };
    /* 点导航项后自动收起，否则手机上会挡住内容 */
    Array.prototype.forEach.call(sn.querySelectorAll('a.nav-item'), function (a) {
      a.addEventListener('click', function () { if (isNarrow()) closeDrawer(); });
    });
  }

  function bindCards() {
    Array.prototype.forEach.call($app.querySelectorAll('[data-goto]'), function (n) {
      n.onclick = function (e) { if (e.target.tagName === 'A') return; go(n.getAttribute('data-goto')); };
    });
  }

  function toggleTheme() {
    const cur = document.documentElement.getAttribute('data-theme');
    const effective = cur || ((window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light');
    const next = effective === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    Store.setPref('theme', next);
  }

  /* =========================================================================
   * 卡片
   * =======================================================================*/
  function modelCard(m) {
    const co = companyOf(m);
    const ind = byId(DB.industries, m.industryId);
    const rec = Store.peek(m.id);
    const total = countInputs(m);
    const done = (rec && rec.correct) || 0;
    const pct = total ? Math.round(done / total * 100) : 0;
    const started = Store.hasWork(m.id);
    return '<div class="model-card" data-market="' + m.market + '" data-goto="#/model/' + m.id + '">' +
      '<div class="mc-top">' +
        '<span class="chip ' + MARKETS[m.market].cls + '">' + MARKETS[m.market].name + '</span>' +
        '<span class="chip ' + LEVELS[m.level].cls + '">' + LEVELS[m.level].name + '</span>' +
        scaleChip(m) +
        (started ? '<span class="chip outline">' + (pct >= 100 ? '已完成' : '进行中 ' + pct + '%') + '</span>' : '') +
      '</div>' +
      '<div class="mc-title">' + esc(m.title) + '</div>' +
      '<div class="mc-desc">' + esc(m.subtitle) + '</div>' +
      '<div class="mc-foot">' +
        (co ? '<span class="mc-co"><span class="logo-dot" style="background:' + (ind ? ind.color : '#888') + '">' + esc(co.short) + '</span>' + esc(co.name) + '</span>' : '<span class="mc-co">通用案例</span>') +
        '<span style="margin-left:auto">' + m.minutes + ' 分钟 · ' + total + ' 格</span>' +
      '</div>' +
      (started ? '<div class="bar' + (pct >= 100 ? ' done' : '') + '" style="margin-top:2px"><i style="width:' + pct + '%"></i></div>' : '') +
      '</div>';
  }

  function resumeCard() {
    const last = Store.last();
    if (!last || !last.modelId || !Store.hasWork(last.modelId)) return '';
    const m = byId(DB.models, last.modelId);
    if (!m) return '';
    const rec = Store.peek(m.id);
    const total = countInputs(m);
    return '<div class="resume">' +
      '<div class="rz-body">' +
        '<div class="rz-k">继续上次的进度</div>' +
        '<div class="rz-t">' + esc(m.title) + '</div>' +
        '<div class="rz-m">最后修改：' + fullTime(rec.updatedAt) + '（' + timeAgo(rec.updatedAt) + '）' +
        (rec.lastCell ? ' · 停在 <span class="num">' + esc(rec.lastCell) + '</span>' : '') +
        ' · 已完成 ' + (rec.correct || 0) + '/' + total + ' 格</div>' +
      '</div>' +
      '<button class="btn primary" onclick="location.hash=\'#/model/' + m.id + '\'">继续 →</button>' +
      '</div>';
  }

  /* =========================================================================
   * 首页
   * =======================================================================*/
  function viewHome() {
    const sum = Store.summary();
    const byLevel = [1, 2, 3].map((l) => DB.models.filter((m) => m.level === l).length);
    const feat = DB.models.filter((m) => ['aapl-income', 'vc-captable', 'tcent-seg', 'msft-atvi', 'byd-3s', 'belle-lbo-full'].indexOf(m.id) >= 0);

    return '<div class="page-head">' +
        '<div class="eyebrow">FINMODEL LAB</div>' +
        '<h1>财务模型实训平台</h1>' +
        '<div class="sub">用真实财报数据搭模型。每一个空格都要你自己写公式——可以引用其他单元格、跨表引用、做加减乘除。' +
        '涵盖一级市场（LBO、并购、Cap Table）与二级市场（三表联动、DCF、行业专题），分简单 / 中级 / 复杂三档。</div>' +
      '</div>' +
      resumeCard() +
      (function () {
        const ids = []; (DB.path || []).forEach(function (s) { s.steps.forEach(function (x) { ids.push(x.id); }); });
        if (!ids.length) return '';
        const st = pathStat(ids);
        const first = ids.filter(function (id) { const m = byId(DB.models, id); const r = Store.peek(id);
          return !(r && m && r.correct >= countInputs(m)); })[0] || ids[0];
        const fm = byId(DB.models, first);
        const mins = ids.reduce(function (a, id) { const m = byId(DB.models, id); return a + (m ? m.minutes : 0); }, 0);
        return '<div class="path-cta">' +
          '<div class="pc-l">' +
            '<div class="pc-k">推荐入口</div>' +
            '<div class="pc-t">按学习路径走一遍</div>' +
            '<div class="pc-d">' + ids.length + ' 个训练分 5 个阶段，按能力递进排列：读表 → 归因 → 预测 → 估值 → 交易。' +
            '每一步都写了它在练什么、为什么排在这个位置。总时长约 ' + Math.round(mins / 60) + ' 小时。</div>' +
            '<div class="pc-b"><div class="bar' + (st.done >= st.of ? ' done' : '') + '"><i style="width:' + st.pct + '%"></i></div>' +
            '<span>已完成 ' + st.done + ' / ' + st.of + '</span></div>' +
          '</div>' +
          '<div class="pc-r">' +
            '<a class="btn primary" href="#/path">查看完整路径 →</a>' +
            (fm ? '<a class="btn" href="#/model/' + fm.id + '">' + (st.done ? '继续下一步' : '从第 1 步开始') + '</a>' : '') +
          '</div>' +
        '</div>';
      })() +
      '<div class="stat-row">' +
        '<div class="stat"><div class="k">模型总数</div><div class="v">' + DB.models.length + '</div></div>' +
        '<div class="stat"><div class="k">覆盖公司</div><div class="v">' + DB.companies.length + '</div></div>' +
        '<div class="stat"><div class="k">覆盖行业</div><div class="v">' + DB.industries.length + '</div></div>' +
        '<div class="stat"><div class="k">已完成模型</div><div class="v">' + sum.completed + '<small> / ' + DB.models.length + '</small></div></div>' +
        '<div class="stat"><div class="k">答对单元格</div><div class="v">' + sum.correctCells + '</div></div>' +
      '</div>' +
      '<div class="two-col">' +
        '<div>' +
          '<h2>从这里开始</h2>' +
          '<div class="grid-cards" style="margin-bottom:26px">' + feat.map(modelCard).join('') + '</div>' +
          '<h2>按市场浏览</h2>' +
          '<div class="grid-cards">' +
            '<div class="model-card" data-market="secondary" data-goto="#/browse/secondary">' +
              '<div class="mc-top"><span class="chip mkt-secondary">二级市场</span></div>' +
              '<div class="mc-title">上市公司财务分析与估值</div>' +
              '<div class="mc-desc">利润表拆解、杜邦分析、分部预测、毛利桥、银行模型、三表联动、DCF 估值。' +
              '数据全部来自年报与 10-K。</div>' +
              '<div class="mc-foot"><span>' + DB.models.filter((m) => m.market === 'secondary').length + ' 个模型</span></div>' +
            '</div>' +
            '<div class="model-card" data-market="primary" data-goto="#/browse/primary">' +
              '<div class="mc-top"><span class="chip mkt-primary">一级市场</span></div>' +
              '<div class="mc-title">私募股权与并购交易模型</div>' +
              '<div class="mc-desc">Cap Table 与稀释、LBO 回报测算、完整 LBO（来源与用途 + 债务表 + 回报归因）、' +
              '现金收购增厚摊薄、控制权收购价格桥、换股吸收合并。</div>' +
              '<div class="mc-foot"><span>' + DB.models.filter((m) => m.market === 'primary').length + ' 个模型</span></div>' +
            '</div>' +
          '</div>' +
        '</div>' +
        '<div>' +
          '<div class="card pad" style="margin-bottom:14px">' +
            '<h3 style="margin-top:0">难度分布</h3>' +
            [1, 2, 3].map((l, i) =>
              '<div style="display:flex;align-items:center;gap:10px;margin-bottom:9px">' +
              '<span class="chip ' + LEVELS[l].cls + '" style="width:52px;justify-content:center">' + LEVELS[l].name + '</span>' +
              '<div class="bar" style="flex:1"><i style="width:' + Math.round(byLevel[i] / DB.models.length * 100) + '%"></i></div>' +
              '<span class="num" style="font-size:12px;color:var(--ink-3)">' + byLevel[i] + '</span></div>').join('') +
            '<div class="footnote" style="margin-top:10px">简单 = 单表、20–35 格；中级 = 单表多模块或含预测；复杂 = 多表联动、含配平与敏感性。</div>' +
          '</div>' +
          '<div class="card pad">' +
            '<h3 style="margin-top:0">行业档案</h3>' +
            DB.industries.map((i) =>
              '<div class="list-row" style="cursor:pointer;padding-left:0;padding-right:0" onclick="location.hash=\'#/industry/' + i.id + '\'">' +
              '<span class="logo-dot" style="background:' + i.color + '">' + esc(i.name.slice(0, 1)) + '</span>' +
              '<div class="lr-main"><div>' + esc(i.name) + '</div><div class="lr-sub">' + esc(i.tagline) + '</div></div>' +
              '</div>').join('') +
          '</div>' +
        '</div>' +
      '</div>';
  }

  /* =========================================================================
   * 学习路径（按能力递进，不按模型类型）
   * =======================================================================*/
  function scaleChip(m) {
    const n = countInputs(m);
    const s = DB.scaleOf ? DB.scaleOf(n) : { t: '', cls: '' };
    return '<span class="chip sz ' + s.cls + '" title="待填 ' + n + ' 格，建议 ' + m.minutes + ' 分钟">' +
      s.t + ' · ' + n + ' 格</span>';
  }

  function pathStat(ids) {
    let done = 0, correct = 0, total = 0;
    ids.forEach(function (id) {
      const m = byId(DB.models, id);
      if (!m) return;
      const t = countInputs(m);
      const rec = Store.peek(id);
      total += t;
      correct += (rec && rec.correct) || 0;
      if (rec && t && rec.correct >= t) done++;
    });
    return { done: done, of: ids.length, pct: total ? Math.round(correct / total * 100) : 0 };
  }

  function pathRow(st, stageNo, stepNo) {
    const m = byId(DB.models, st.id);
    if (!m) return '';
    const co = companyOf(m);
    const rec = Store.peek(m.id);
    const total = countInputs(m);
    const pct = (rec && rec.correct && total) ? Math.round(rec.correct / total * 100) : 0;
    const state = !Store.hasWork(m.id) ? '<span class="cc-state">未开始</span>'
      : pct >= 100 ? '<span class="cc-state done">✓ 已完成</span>'
        : '<span class="cc-state doing">' + pct + '%</span>';
    return '<div class="pt-row" data-goto="#/model/' + m.id + '">' +
      '<span class="pt-n">' + stageNo + '.' + stepNo + '</span>' +
      '<div class="pt-m">' +
        '<b>' + esc(m.title) + (m.fullCase ? '<span class="cc-tag">完整案例</span>' : '') + '</b>' +
        '<span class="pt-why">' + esc(st.note) + '</span>' +
      '</div>' +
      '<div class="pt-meta">' +
        '<span class="chip ' + LEVELS[m.level].cls + '">' + LEVELS[m.level].name + '</span>' +
        scaleChip(m) +
        '<span class="pt-min">' + m.minutes + ' 分钟</span>' +
      '</div>' +
      state +
      '<span class="cc-go">↗</span>' +
      '</div>';
  }

  function viewPath() {
    const stages = DB.path || [];
    const allIds = [];
    stages.forEach(function (s) { s.steps.forEach(function (st) { allIds.push(st.id); }); });
    const overall = pathStat(allIds);
    const mins = allIds.reduce(function (a, id) { const m = byId(DB.models, id); return a + (m ? m.minutes : 0); }, 0);

    let stepNo = 0;
    const body = stages.map(function (s, si) {
      const ids = s.steps.map(function (x) { return x.id; });
      const st = pathStat(ids);
      const stMins = ids.reduce(function (a, id) { const m = byId(DB.models, id); return a + (m ? m.minutes : 0); }, 0);
      return '<section class="pt-stage">' +
        '<header class="pt-head">' +
          '<div class="pt-badge">阶段 ' + (si + 1) + '</div>' +
          '<div class="pt-htxt">' +
            '<h2>' + esc(s.name) + '</h2>' +
            '<p class="pt-goal"><b>目标：</b>' + esc(s.goal) + '</p>' +
            '<p class="pt-why-stage">' + esc(s.why) + '</p>' +
          '</div>' +
          '<div class="pt-hstat">' +
            '<div class="num">' + st.done + '/' + st.of + '</div>' +
            '<div class="bar' + (st.done >= st.of ? ' done' : '') + '"><i style="width:' + st.pct + '%"></i></div>' +
            '<div class="pt-hmin">约 ' + Math.round(stMins / 60 * 10) / 10 + ' 小时</div>' +
          '</div>' +
        '</header>' +
        '<div class="pt-list">' + s.steps.map(function (x, i) { stepNo++; return pathRow(x, si + 1, i + 1); }).join('') + '</div>' +
      '</section>';
    }).join('');

    const extras = (DB.pathExtras || []).map(function (x) {
      const m = byId(DB.models, x.id);
      if (!m) return '';
      return '<div class="pt-row" data-goto="#/model/' + m.id + '">' +
        '<span class="pt-n">专题</span>' +
        '<div class="pt-m"><b>' + esc(m.title) + '</b><span class="pt-why">' + esc(x.note) + '</span></div>' +
        '<div class="pt-meta"><span class="chip ' + LEVELS[m.level].cls + '">' + LEVELS[m.level].name + '</span>' + scaleChip(m) +
        '<span class="pt-min">' + m.minutes + ' 分钟</span></div>' +
        '<span class="cc-go">↗</span></div>';
    }).join('');

    return '<div class="page-head">' +
        '<div class="eyebrow">学习路径</div><h1>按顺序做完，就是一套完整的建模训练</h1>' +
        '<div class="sub">路径按<b>能力</b>递进排列，不按模型类型——读表 → 归因 → 预测 → 估值 → 交易。' +
        '每一步都写了它在练什么、为什么排在这个位置。没有基础的话，从阶段 1 第 1 步开始，' +
        '不要跳着做：后面的训练会直接用到前面建立的直觉。</div>' +
      '</div>' +
      '<div class="stat-row">' +
        '<div class="stat"><div class="k">主线训练</div><div class="v">' + allIds.length + '</div></div>' +
        '<div class="stat"><div class="k">已完成</div><div class="v">' + overall.done + '<small> / ' + allIds.length + '</small></div></div>' +
        '<div class="stat"><div class="k">整体进度</div><div class="v">' + overall.pct + '<small>%</small></div></div>' +
        '<div class="stat"><div class="k">预计总时长</div><div class="v">' + Math.round(mins / 60) + '<small> 小时</small></div></div>' +
      '</div>' +
      '<div class="callout info" style="margin-bottom:22px">' +
        '<b>关于难度标签：</b>「简单 / 中级 / 复杂」说的是<b>概念难度</b>，' +
        '旁边的「小 / 中 / 大 / 特大 · N 格」说的是<b>工作量</b>。两者不一定同向——' +
        '腾讯 SOTP 只有 18 格但概念是中级，苹果利润表拆解有 49 格但概念很简单。安排时间时看后者。' +
      '</div>' +
      body +
      (extras ? '<section class="pt-stage"><header class="pt-head">' +
        '<div class="pt-badge extra">专题</div>' +
        '<div class="pt-htxt"><h2>不在主线上的专题</h2>' +
        '<p class="pt-why-stage">口径体系与主线差异太大，不适合排进递进路径，按需单学即可。</p></div>' +
        '</header><div class="pt-list">' + extras + '</div></section>' : '');
  }

  /* =========================================================================
   * 训练课程（按模型类型分类）
   * =======================================================================*/
  function typeOf(m) { return byId(DB.modelTypes || [], m.type); }
  function modelsOfType(tid) {
    return DB.models.filter(function (m) { return m.type === tid; })
      .sort(function (a, b) { return (a.level - b.level) || (b.fullCase ? 1 : 0) - (a.fullCase ? 1 : 0); });
  }

  function trainingRow(m, i) {
    const co = companyOf(m);
    const rec = Store.peek(m.id);
    const total = countInputs(m);
    const pct = (rec && rec.correct && total) ? Math.round(rec.correct / total * 100) : 0;
    const state = !Store.hasWork(m.id) ? '<span class="cc-state">可练习</span>'
      : pct >= 100 ? '<span class="cc-state done">已完成</span>'
        : '<span class="cc-state doing">进行中 ' + pct + '%</span>';
    return '<div class="cc-row" data-goto="#/model/' + m.id + '">' +
      '<span class="cc-n">' + String(i + 1).padStart(2, '0') + '</span>' +
      '<div class="cc-m">' +
        '<b>' + esc(m.title) + (m.fullCase ? '<span class="cc-tag">完整案例</span>' : '') + '</b>' +
        '<span>' + (co ? esc(co.name) + ' · ' : '') + esc(m.subtitle) + '</span>' +
      '</div>' +
      '<span class="chip ' + LEVELS[m.level].cls + '">' + LEVELS[m.level].name + '</span>' +
      scaleChip(m) +
      '<span class="cc-ws">' + m.sheets.length + ' 表 · ' + m.minutes + ' 分钟</span>' +
      state +
      '<span class="cc-go">↗</span>' +
      '</div>';
  }

  function courseCard(t) {
    const ms = modelsOfType(t.id);
    const lv = { 1: 0, 2: 0, 3: 0 };
    ms.forEach(function (m) { lv[m.level]++; });
    const gaps = [1, 2, 3].filter(function (l) { return !lv[l]; });
    return '<div class="course-card">' +
      '<div class="cc-head" data-goto="#/type/' + t.id + '">' +
        '<span class="cc-icon" style="background:' + t.color + '18;color:' + t.color + '">' + t.icon + '</span>' +
        '<div class="cc-title"><b>' + esc(t.name) + '</b><span>' + esc(t.tagline) + '</span></div>' +
        '<span class="chip outline">' + ms.length + ' 个训练</span>' +
      '</div>' +
      (ms.length ? '<div class="cc-list">' + ms.map(trainingRow).join('') + '</div>'
        : '<div class="cc-empty">这个类型的训练还在建设中</div>') +
      (gaps.length && ms.length ? '<div class="cc-foot">尚缺：' + gaps.map(function (l) { return LEVELS[l].name; }).join(' / ') + '</div>' : '') +
      '</div>';
  }

  function viewCourses() {
    const types = (DB.modelTypes || []).slice();
    const withM = types.filter(function (t) { return modelsOfType(t.id).length; });
    const without = types.filter(function (t) { return !modelsOfType(t.id).length; });
    const ordered = withM.concat(without);
    const full = DB.models.filter(function (m) { return m.fullCase; });

    return '<div class="page-head">' +
        '<div class="eyebrow">训练课程</div><h1>按模型类型训练</h1>' +
        '<div class="sub">每一类模型是一门课，课下按 简单 / 中级 / 复杂 排列具体的公司训练。' +
        '标着「完整案例」的，会从公司披露的原始三张报表出发，经过勾稽桥一路搭到模型。</div>' +
      '</div>' +
      (full.length ? '<div class="card pad" style="margin-bottom:20px">' +
        '<h3 style="margin-top:0">完整案例 · 从三张真实报表到模型</h3>' +
        '<div class="footnote" style="margin-bottom:12px">起点是 10-K / 年报原文的三张报表，不是整理好的摘要。' +
        '中间的「勾稽桥」会带你验证三表之间必须对上的线，并解释对不上的差额是什么——这一步是真实工作里最容易被跳过、也最不该跳过的。</div>' +
        '<div class="cc-list">' + full.map(trainingRow).join('') + '</div></div>' : '') +
      '<div class="course-grid">' + ordered.map(courseCard).join('') + '</div>';
  }

  function viewType(id) {
    const t = byId(DB.modelTypes || [], id);
    if (!t) return shell('<div class="empty">找不到这个模型类型</div>');
    const ms = modelsOfType(id);
    const byLevel = [1, 2, 3].map(function (l) { return { l: l, list: ms.filter(function (m) { return m.level === l; }) }; });

    shell('<div class="page-head">' +
        '<div class="eyebrow" style="color:' + t.color + '">' + esc(t.en) + '</div>' +
        '<h1><span class="cc-icon" style="background:' + t.color + '18;color:' + t.color + ';vertical-align:-6px;margin-right:10px">' + t.icon + '</span>' + esc(t.name) + '</h1>' +
        '<div class="sub">' + esc(t.tagline) + '</div>' +
      '</div>' +
      '<div class="two-col">' +
        '<div>' +
          byLevel.map(function (g) {
            return '<div style="margin-bottom:22px">' +
              '<h2 style="display:flex;align-items:center;gap:9px;font-size:16px">' +
              '<span class="chip ' + LEVELS[g.l].cls + '">' + LEVELS[g.l].name + '</span>' +
              '<span style="color:var(--ink-3);font-size:13px;font-weight:400">' + g.list.length + ' 个训练</span></h2>' +
              (g.list.length ? '<div class="card"><div class="cc-list">' + g.list.map(trainingRow).join('') + '</div></div>'
                : '<div class="cc-empty" style="border:1px dashed var(--border);border-radius:10px">这一档还在建设中</div>') +
              '</div>';
          }).join('') +
        '</div>' +
        '<div>' +
          '<div class="card pad" style="margin-bottom:14px"><h3 style="margin-top:0">这类模型在做什么</h3>' +
          '<p style="font-size:13.5px;color:var(--ink-2)">' + esc(t.desc) + '</p></div>' +
          '<div class="card pad"><h3 style="margin-top:0">要掌握的技能</h3>' +
          '<div class="tag-row">' + t.skills.map(function (s) { return '<span class="chip outline">' + esc(s) + '</span>'; }).join('') + '</div></div>' +
        '</div>' +
      '</div>');
  }

  /* =========================================================================
   * 模型列表
   * =======================================================================*/
  function viewBrowse(scope) {
    let list = DB.models.slice();
    if (scope === 'secondary' || scope === 'primary') list = list.filter((m) => m.market === scope);
    if (S.filterLevel !== 'all') list = list.filter((m) => String(m.level) === S.filterLevel);
    if (S.filterIndustry !== 'all') list = list.filter((m) => m.industryId === S.filterIndustry);
    list.sort((a, b) => (a.level - b.level) || a.title.localeCompare(b.title, 'zh'));

    const title = scope === 'secondary' ? '二级市场模型' : scope === 'primary' ? '一级市场模型' : '全部模型';
    const desc = scope === 'secondary'
      ? '上市公司财报分析与估值。所有历史数据均来自公司年报 / Form 10-K，预测假设已在表内明确标注。'
      : scope === 'primary'
        ? '私募股权与并购交易建模。交易条款来自公开公告，未披露的融资细节以教学假设呈现并标注。'
        : '按市场、难度、行业筛选。点开任意模型即可开始，进度自动保存。';

    const seg = (id, cur, opts) => '<div class="seg" data-seg="' + id + '">' +
      opts.map((o) => '<button data-v="' + o.v + '"' + (cur === o.v ? ' class="on"' : '') + '>' + o.t + '</button>').join('') + '</div>';

    setTimeout(function () {
      Array.prototype.forEach.call($app.querySelectorAll('[data-seg]'), function (segEl) {
        const key = segEl.getAttribute('data-seg');
        Array.prototype.forEach.call(segEl.querySelectorAll('button'), function (b) {
          b.onclick = function () {
            if (key === 'level') S.filterLevel = b.getAttribute('data-v');
            if (key === 'ind') S.filterIndustry = b.getAttribute('data-v');
            shell(viewBrowse(scope));
          };
        });
      });
    }, 0);

    return '<div class="page-head"><div class="eyebrow">模型库</div><h1>' + title + '</h1><div class="sub">' + desc + '</div></div>' +
      '<div class="toolbar">' +
        seg('level', S.filterLevel, [{ v: 'all', t: '全部难度' }, { v: '1', t: '简单' }, { v: '2', t: '中级' }, { v: '3', t: '复杂' }]) +
        seg('ind', S.filterIndustry, [{ v: 'all', t: '全部行业' }].concat(DB.industries.map((i) => ({ v: i.id, t: i.name })))) +
        '<span style="margin-left:auto;font-size:12.5px;color:var(--ink-3)">共 ' + list.length + ' 个</span>' +
      '</div>' +
      (list.length ? '<div class="grid-cards">' + list.map(modelCard).join('') + '</div>'
        : '<div class="empty"><div class="big">∅</div>没有符合条件的模型，换个筛选试试。</div>');
  }

  /* =========================================================================
   * 行业页
   * =======================================================================*/
  function viewIndustry(id) {
    const ind = byId(DB.industries, id);
    if (!ind) return shell('<div class="empty">找不到这个行业</div>');
    const cos = DB.companies.filter((c) => c.industry === id);
    const ms = modelsOfIndustry(id);

    shell('<div class="page-head">' +
        '<div class="eyebrow" style="color:' + ind.color + '">' + esc(ind.en) + '</div>' +
        '<h1>' + esc(ind.name) + '</h1>' +
        '<div class="sub">' + esc(ind.tagline) + '</div>' +
      '</div>' +
      '<div class="two-col">' +
        '<div class="card pad prose">' +
          '<h3>行业概览</h3>' +
          ind.overview.split('\n\n').map((p) => '<p>' + esc(p) + '</p>').join('') +
          '<h3>这一类公司的财报特点（归纳总结）</h3>' +
          ind.traits.map((t, i) => '<p><strong>' + (i + 1) + '. ' + esc(t.t) + '</strong><br>' + esc(t.d) + '</p>').join('') +
          '<h3>常犯的错误</h3>' +
          '<ul>' + ind.pitfalls.map((p) => '<li>' + esc(p) + '</li>').join('') + '</ul>' +
        '</div>' +
        '<div>' +
          '<div class="card pad" style="margin-bottom:14px">' +
            '<h3 style="margin-top:0">关键指标清单</h3>' +
            '<div class="tag-row">' + ind.metrics.map((m) => '<span class="chip outline">' + esc(m) + '</span>').join('') + '</div>' +
          '</div>' +
          '<div class="card" style="margin-bottom:14px">' +
            '<div class="pad" style="padding-bottom:6px"><h3 style="margin:0">本行业公司（' + cos.length + '）</h3></div>' +
            cos.map((c) => '<div class="list-row" style="cursor:pointer" onclick="location.hash=\'#/company/' + c.id + '\'">' +
              '<span class="logo-dot" style="background:' + esc(c.color) + '">' + esc(c.short) + '</span>' +
              '<div class="lr-main"><div>' + esc(c.name) + ' <span class="lr-sub">' + esc(c.ticker) + '</span></div>' +
              '<div class="lr-sub">' + esc(c.tagline) + '</div></div>' +
              '<span class="chip outline">' + modelsOfCompany(c.id).length + ' 模型</span></div>').join('') +
          '</div>' +
        '</div>' +
      '</div>' +
      '<h2 style="margin-top:28px">本行业的模型（' + ms.length + '）</h2>' +
      '<div class="grid-cards">' + ms.map(modelCard).join('') + '</div>');
  }

  /* =========================================================================
   * 公司页
   * =======================================================================*/
  function viewCompany(id) {
    const c = byId(DB.companies, id);
    if (!c) return shell('<div class="empty">找不到这家公司</div>');
    const ind = byId(DB.industries, c.industry);
    const ms = modelsOfCompany(c.id);
    const kd = c.keyData;

    const kdTable = kd ? '<div style="overflow-x:auto"><table class="kv-table">' +
      '<thead><tr><th>' + esc(kd.unit) + '</th>' + kd.years.map((y) => '<th>' + esc(y) + '</th>').join('') + '</tr></thead>' +
      '<tbody>' + kd.rows.map((r) =>
        '<tr' + (r.sub ? '' : ' class=""') + '><td>' + esc(r.k) + '</td>' +
        r.v.map((v) => '<td class="n">' + (v === null || v === undefined ? '—' : fmtVal(v, r.fmt || 'num0')) + '</td>').join('') +
        '</tr>').join('') + '</tbody></table></div>' : '';

    shell('<div class="co-hero">' +
        '<div class="co-logo" style="background:' + esc(c.color) + '">' + esc(c.short) + '</div>' +
        '<div style="flex:1">' +
          '<div class="eyebrow" style="color:var(--ink-3)">' + esc(c.en) + ' · ' + esc(c.ticker) + ' · ' + esc(c.venue) + '</div>' +
          '<h1 style="margin-bottom:4px">' + esc(c.name) + '</h1>' +
          '<div class="sub">' + esc(c.tagline) + '</div>' +
          '<div class="tag-row" style="margin-top:8px">' +
            (ind ? '<a class="chip" style="background:' + ind.color + '18;color:' + ind.color + '" href="#/industry/' + ind.id + '">' + esc(ind.name) + '</a>' : '') +
            '<span class="chip outline">' + esc(c.fy) + '</span>' +
            '<span class="chip outline">' + ms.length + ' 个模型</span>' +
          '</div>' +
        '</div>' +
      '</div>' +
      '<div class="two-col" style="margin-top:22px">' +
        '<div class="card pad prose">' +
          '<h3>案例背景 · 公司</h3>' +
          c.background.company.split('\n\n').map((p) => '<p>' + esc(p) + '</p>').join('') +
          '<h3>案例背景 · 行业</h3>' +
          c.background.industry.split('\n\n').map((p) => '<p>' + esc(p) + '</p>').join('') +
          '<h3>财报特点</h3>' +
          c.traits.map((t) => '<p><strong>' + esc(t.t) + '</strong><br>' + esc(t.d) + '</p>').join('') +
          '<h3>未来看法</h3>' +
          '<ul>' + c.outlook.map((o) => '<li>' + esc(o) + '</li>').join('') + '</ul>' +
          '<h3>风险点</h3>' +
          c.risks.map((t) => '<div class="callout risk"><b>' + esc(t.t) + '</b><br>' + esc(t.d) + '</div>').join('') +
        '</div>' +
        '<div>' +
          '<div class="card pad" style="margin-bottom:14px">' +
            '<h3 style="margin-top:0">关键财务数据</h3>' + kdTable +
            '<div class="footnote" style="margin-top:10px">' + esc(c.source) + '</div>' +
          '</div>' +
          '<div class="card">' +
            '<div class="pad" style="padding-bottom:6px"><h3 style="margin:0">相关模型</h3></div>' +
            (ms.length ? ms.map((m) => '<div class="list-row" style="cursor:pointer" onclick="location.hash=\'#/model/' + m.id + '\'">' +
              '<span class="chip ' + LEVELS[m.level].cls + '">' + LEVELS[m.level].name + '</span>' +
              '<div class="lr-main"><div>' + esc(m.title) + '</div><div class="lr-sub">' + m.minutes + ' 分钟 · ' + countInputs(m) + ' 个待填单元格</div></div>' +
              '</div>').join('') : '<div class="pad footnote">暂无</div>') +
          '</div>' +
        '</div>' +
      '</div>');
  }

  /* =========================================================================
   * 进度页
   * =======================================================================*/
  function viewProgress() {
    const all = Store.all();
    const rows = DB.models.map((m) => {
      const rec = all.models[m.id];
      return { m: m, rec: rec, ts: rec ? rec.updatedAt : 0, started: Store.hasWork(m.id) };
    }).filter((x) => x.started).sort((a, b) => b.ts - a.ts);

    const sum = Store.summary();
    setTimeout(function () {
      const ex = document.getElementById('btnExport');
      if (ex) ex.onclick = function () {
        const blob = new Blob([Store.exportJSON()], { type: 'application/json' });
        const name = 'finmodel-lab-进度-' + new Date().toISOString().slice(0, 10) + '.json';
        Save.file(blob, name)
          .then(function () { toast('进度已导出', 'ok'); })
          .catch(function (err) {
            if (err && err.code === 'declined') { toast('已取消'); return; }
            toast('导出失败：' + err.message, 'err', 8000);
          });
      };
      const im = document.getElementById('btnImport');
      if (im) im.onclick = function () {
        const inp = document.createElement('input');
        inp.type = 'file'; inp.accept = '.json';
        inp.onchange = function () {
          const f = inp.files[0]; if (!f) return;
          const rd = new FileReader();
          rd.onload = function () {
            try { Store.importJSON(rd.result); toast('导入成功', 'ok'); render(); }
            catch (e) { toast('导入失败：' + e.message, 'err'); }
          };
          rd.readAsText(f);
        };
        inp.click();
      };
      const cl = document.getElementById('btnClear');
      if (cl) cl.onclick = function () {
        if (confirm('确定要清空全部学习记录吗？此操作不可撤销。建议先导出备份。')) { Store.clearAll(); render(); toast('已清空'); }
      };
    }, 0);

    return '<div class="page-head"><div class="eyebrow">学习记录</div><h1>我的进度</h1>' +
      '<div class="sub">所有作答内容都保存在这台设备的浏览器里，每改一格自动保存。换设备时可以用下面的导出 / 导入迁移。</div></div>' +
      '<div class="stat-row">' +
        '<div class="stat"><div class="k">已开始</div><div class="v">' + sum.started + '<small> / ' + DB.models.length + '</small></div></div>' +
        '<div class="stat"><div class="k">已完成</div><div class="v">' + sum.completed + '</div></div>' +
        '<div class="stat"><div class="k">答对单元格</div><div class="v">' + sum.correctCells + '</div></div>' +
        '<div class="stat"><div class="k">累计用时</div><div class="v">' + Math.round(sum.seconds / 60) + '<small> 分钟</small></div></div>' +
      '</div>' +
      '<div class="toolbar">' +
        '<button class="btn" id="btnExport">导出备份</button>' +
        '<button class="btn" id="btnImport">导入备份</button>' +
        '<button class="btn" id="btnClear" style="margin-left:auto;color:var(--err)">清空全部记录</button>' +
      '</div>' +
      (rows.length ? '<div class="card">' + rows.map((x) => {
        const total = countInputs(x.m);
        const pct = total ? Math.round((x.rec.correct || 0) / total * 100) : 0;
        return '<div class="list-row" style="cursor:pointer" onclick="location.hash=\'#/model/' + x.m.id + '\'">' +
          '<span class="chip ' + LEVELS[x.m.level].cls + '">' + LEVELS[x.m.level].name + '</span>' +
          '<div class="lr-main"><div>' + esc(x.m.title) + '</div>' +
          '<div class="lr-sub">最后修改 ' + fullTime(x.ts) + ' · ' + timeAgo(x.ts) +
          (x.rec.lastCell ? ' · 停在 ' + esc(x.rec.lastCell) : '') + '</div></div>' +
          '<div style="width:120px"><div class="bar' + (pct >= 100 ? ' done' : '') + '"><i style="width:' + pct + '%"></i></div>' +
          '<div class="lr-sub" style="text-align:right;margin-top:3px">' + (x.rec.correct || 0) + '/' + total + '</div></div>' +
          '</div>';
      }).join('') + '</div>' : '<div class="empty"><div class="big">◔</div>还没有学习记录。随便挑一个模型开始吧。</div>');
  }

  /* =========================================================================
   * 使用说明
   * =======================================================================*/
  function viewAbout() {
    return '<div class="page-head"><div class="eyebrow">使用说明</div><h1>怎么用这个平台</h1></div>' +
      '<div class="card pad prose" style="max-width:820px">' +
      '<h3>单元格怎么填</h3>' +
      '<p>浅蓝色的格子是需要你作答的。它和 Excel 一样：以 <code>=</code> 开头就是公式，可以引用其他单元格、做加减乘除、用括号、写函数。</p>' +
      '<ul>' +
      '<li><b>引用本表单元格</b>：<code>=B3-B6</code>、<code>=B11/B3</code></li>' +
      '<li><b>跨表引用</b>：<code>=\'假设\'!B3</code>、<code>=\'利润表\'!C8*\'假设\'!B14/365</code></li>' +
      '<li><b>区域求和</b>：<code>=SUM(B3:B6)</code></li>' +
      '<li><b>绝对引用</b>：<code>=$B$25</code>（本平台不做拖拽填充，$ 只是习惯写法，效果与相对引用相同）</li>' +
      '<li><b>百分比</b>：可以直接写 <code>15%</code>，等价于 <code>0.15</code></li>' +
      '<li><b>幂运算</b>：<code>=B27^(1/B26)-1</code>（算年化回报常用）</li>' +
      '</ul>' +
      '<h3>鼠标点选引用</h3>' +
      '<p>正在编辑公式时，如果光标前是 <code>=</code>、<code>+</code>、<code>-</code>、<code>*</code>、<code>/</code>、<code>(</code>、<code>,</code> 这类符号，' +
      '直接用鼠标点另一个格子，它的地址会自动插进来；<b>按住拖过一片区域</b>会插入 <code>B3:D3</code> 这样的区域引用。和 Excel 完全一样。</p>' +
      '<h3>拖拽填充</h3>' +
      '<p>选中格子后，右下角会出现一个小方块（填充柄）。按住它往右或往下拖，公式会被复制过去，' +
      '并且<b>相对引用自动平移</b>：<code>=B3-B6</code> 往右拖一格变成 <code>=C3-C6</code>，往下拖一格变成 <code>=B4-B7</code>。' +
      '用 <code>$</code> 锁定的部分不会动——<code>=1/(1+$B$25)^C29</code> 往右拖，只有 <code>C29</code> 变。</p>' +
      '<p>也可以选中一片区域后按 <kbd>Ctrl</kbd>+<kbd>D</kbd> 向下填充、<kbd>Ctrl</kbd>+<kbd>R</kbd> 向右填充。</p>' +
      '<h3>复制粘贴（含 Excel）</h3>' +
      '<ul>' +
      '<li><b>站内复制</b>（<kbd>Ctrl</kbd>+<kbd>C</kbd> / <kbd>Ctrl</kbd>+<kbd>V</kbd>）：保留公式并按位移平移引用，和 Excel 一致。</li>' +
      '<li><b>从 Excel 粘贴</b>：支持多行多列（制表符分隔）。以 <code>=</code> 开头的会当公式原样写入，不做平移。</li>' +
      '<li>粘贴时遇到只读格会自动跳过，并在底部状态栏告诉你跳过了几格。</li>' +
      '</ul>' +
      '<h3>支持的函数</h3>' +
      '<p class="footnote">SUM、AVERAGE、MEDIAN、MIN、MAX、COUNT、PRODUCT、ABS、ROUND、ROUNDUP、ROUNDDOWN、INT、SQRT、POWER、EXP、LN、LOG、' +
      'IF、IFERROR、AND、OR、NOT、SUMPRODUCT、NPV、IRR、PMT、PV、FV、SIGN、ISNUMBER</p>' +
      '<h3>检查与提示</h3>' +
      '<ul>' +
      '<li><b>检查本表</b> / <b>检查全部</b>：把答对的标绿、答错的标红。数值容差 0.2%，所以四舍五入的小差异不会判错。</li>' +
      '<li><b>提示</b>：显示当前单元格该怎么想。</li>' +
      '<li><b>显示参考公式</b>：直接把参考答案填进当前格。用过之后这一格会被记为"已看答案"。</li>' +
      '</ul>' +
      '<h3>进度保存</h3>' +
      '<p>每改一格就自动保存到浏览器本地，包含最后修改时间和你停在哪个单元格。' +
      '下次打开首页会看到"继续上次的进度"。在<a href="#/progress">我的进度</a>里可以导出 JSON 备份，换电脑时导入即可。</p>' +
      '<h3>快捷键</h3>' +
      '<p><kbd>↑</kbd><kbd>↓</kbd><kbd>←</kbd><kbd>→</kbd> 移动 · <kbd>Shift</kbd>+方向键 扩选 · ' +
      '<kbd>Enter</kbd> / <kbd>F2</kbd> / 双击 进入编辑 · 直接打字也会进入编辑 · ' +
      '<kbd>Tab</kbd> 右移 · <kbd>Delete</kbd> 清除选区 · <kbd>Esc</kbd> 取消编辑 · ' +
      '<kbd>Ctrl</kbd>+<kbd>D</kbd> / <kbd>Ctrl</kbd>+<kbd>R</kbd> 填充</p>' +
      '<h3>完整案例是什么</h3>' +
      '<p>标着「完整案例」的训练有 6–9 张工作表，起点是公司 10-K / 年报里<b>原封不动的三张报表</b>，' +
      '而不是整理好的摘要。中间有一张「勾稽桥」，带你验证三表之间必须对上的线' +
      '（净利润、资产=负债+权益、现金变动），并解释那些注定对不上的差额是什么。' +
      '走完这一步，才轮到搭预测模型。在<a href="#/courses">训练课程</a>里可以按模型类型找到它们。</p>' +
      '<h3 style="color:var(--err)">重要声明</h3>' +
      '<p class="footnote">本平台所有历史财务数据均整理自公司公开披露的年度报告、Form 10-K 及交易公告，来源已在每个模型的"数据说明"中标注。' +
      '凡预测、假设、未公开披露的交易参数，均在表内明确标注为"教学假设"。' +
      '本平台内容仅用于财务建模的技能训练，不构成任何投资建议、估值结论或对相关公司与交易的评价。' +
      '实际使用时请以公司披露的原始文件为准。</p>' +
      '</div>';
  }

  /* =========================================================================
   * 建模页
   * =======================================================================*/
  function viewModel(id) {
    const m = byId(DB.models, id);
    if (!m) return shell('<div class="empty">找不到这个模型</div>');
    S.model = m;
    S.startTs = Date.now();
    const rec = Store.model(m.id);
    S.inputs = Object.assign({}, rec.inputs);
    S.sheetIdx = Math.min(rec.lastSheet || 0, m.sheets.length - 1);
    S.showChecks = false;
    S.actInfo = null;
    rebuild();

    const co = companyOf(m);
    const typ = m.type ? (byId(DB.modelTypes || [], m.type) || null) : null;
    $app.innerHTML =
      '<div class="lab">' +
        '<div class="lab-head">' +
          '<button class="btn ghost sm" id="btnBack">← 返回</button>' +
          '<div>' +
            '<div class="lh-title">' + esc(m.title) + '</div>' +
            '<div class="lh-meta">' + (co ? esc(co.name) + ' · ' : '') + (typ ? esc(typ.name) + ' · ' : '') +
              MARKETS[m.market].name + ' · ' + LEVELS[m.level].name + ' · 建议 ' + m.minutes + ' 分钟</div>' +
          '</div>' +
          '<span class="chip ' + LEVELS[m.level].cls + '">' + LEVELS[m.level].name + '</span>' +
          scaleChip(m) +
          '<div class="spacer"></div>' +
          '<div class="save-dot" id="saveDot"><i></i><span>已保存</span></div>' +
          '<button class="btn sm" id="btnSide">说明</button>' +
          '<button class="btn sm" id="btnHint">提示</button>' +
          '<button class="btn sm" id="btnReveal">显示参考公式</button>' +
          '<button class="btn sm" id="btnXlsx">导出 Excel</button>' +
          '<button class="btn sm" id="btnReset">重置</button>' +
          '<button class="btn primary sm" id="btnCheck">检查全部</button>' +
        '</div>' +
        '<div class="lab-body">' +
          '<div class="lab-side' + (isNarrow() ? ' collapsed' : '') + '" id="labSide"></div>' +
          '<div class="lab-main">' +
            '<div class="tabs" id="tabs"></div>' +
            '<div class="fx-bar">' +
              '<div class="fx-addr" id="fxAddr">—</div>' +
              '<div class="fx-icon">fx</div>' +
              '<input class="fx-input" id="fxInput" spellcheck="false" placeholder="选中单元格后在这里写公式，例如 =B3-B6；也可以直接在格内输入" disabled>' +
            '</div>' +
            '<div class="sheet-wrap" id="sheetWrap"></div>' +
            '<div class="grid-status" id="gridStatus"></div>' +
          '</div>' +
        '</div>' +
      '</div>';

    document.getElementById('btnBack').onclick = function () {
      if (history.length > 1) history.back(); else location.hash = '#/browse/all';
    };
    document.getElementById('btnCheck').onclick = function () { checkAll(); };
    document.getElementById('btnReset').onclick = function () {
      if (!confirm('清空本模型的全部作答？清空前会自动存一个还原点。')) return;
      Store.resetModel(m.id); S.inputs = {}; rebuild(); mountGrid(); renderSide(); toast('已清空');
    };
    document.getElementById('btnXlsx').onclick = function (e) {
      if (!window.Xlsx || !window.Save) { toast('导出模块未加载', 'err'); return; }
      const withAns = e.altKey || e.shiftKey;
      const btn = this;
      btn.disabled = true;
      Promise.resolve()
        .then(function () { return Xlsx.download(m, S.inputs, { withAnswers: withAns }); })
        .then(function (r) {
          if (r.renamed) {
            toast('已保存为 ' + r.filename + '（' + Math.round(r.size / 1024) + ' KB）——' +
              '这里不收 .xlsx 后缀，把文件名改回 ' + r.original + ' 就能用 Excel 打开', 'warn', 9000);
          } else {
            toast('已导出 .xlsx（' + Math.round(r.size / 1024) + ' KB）' +
              (withAns ? '，含参考答案' : '，按住 Shift 点可导出参考答案'), 'ok');
          }
        })
        .catch(function (err) {
          if (err && err.code === 'declined') { toast('已取消'); return; }
          toast('导出失败：' + err.message, 'err', 8000);
        })
        .then(function () { btn.disabled = false; });
    };
    document.getElementById('btnHint').onclick = function () { showHint(); };
    document.getElementById('btnReveal').onclick = function () { revealCurrent(); };
    document.getElementById('btnSide').onclick = function () {
      document.getElementById('labSide').classList.toggle('collapsed');
    };

    const fx = document.getElementById('fxInput');
    fx.addEventListener('keydown', function (e) {
      if (Grid.isEditing()) { Grid.editorKey(e); return; }
      if (e.key === 'Enter') { e.preventDefault(); applyFx(); }
      else if (e.key === 'Escape') { e.preventDefault(); syncFx(); Grid.focus(); }
    });
    fx.addEventListener('blur', function () {
      if (!Grid.isEditing() && fx.dataset.dirty === '1') applyFx();
    });
    fx.addEventListener('input', function () {
      if (Grid.isEditing()) Grid.setEditValue(fx.value);
      else fx.dataset.dirty = '1';
    });
    /* 点公式栏 = 开始编辑当前格（这样可以先在公式栏起头，再去别的表点单元格） */
    fx.addEventListener('focus', function () {
      if (!Grid.isEditing() && S.actInfo && S.actInfo.kind === 'input') Grid.beginEditActive(fx.value);
    });

    renderTabs(); mountGrid(); renderSide();
  }

  function applyFx() {
    const fx = document.getElementById('fxInput');
    if (!fx || fx.disabled) return;
    fx.dataset.dirty = '0';
    if (Grid.setActiveValue(fx.value)) { updateProgress(); renderSide(); }
    Grid.focus();
  }

  function rebuild() {
    const m = S.model;
    S.wb = new FML.Workbook(m, makeGetter(m, S.inputs, false));
    S.sol = new FML.Workbook(m, makeGetter(m, {}, true));
  }

  function renderTabs() {
    const m = S.model;
    const t = document.getElementById('tabs');
    const ed = Grid.isEditing && Grid.isEditing() ? Grid.editInfo() : null;
    t.innerHTML = m.sheets.map(function (s, i) {
      const isEdit = ed && ed.sheetIdx === i;
      return '<button' + (i === S.sheetIdx ? ' class="on"' : (isEdit ? ' class="editing-src"' : '')) + ' data-i="' + i + '">' +
        '<span class="tb-n">' + String(i + 1).padStart(2, '0') + '</span>' + esc(s.name) +
        (isEdit && i !== S.sheetIdx ? '<span class="tb-dot" title="正在这张表上编辑公式">●</span>' : '') + '</button>';
    }).join('');
    Array.prototype.forEach.call(t.querySelectorAll('button'), function (b) {
      /* 用 mousedown 并阻止默认行为，避免正在编辑的输入框先失焦 */
      b.addEventListener('mousedown', function (e) {
        e.preventDefault();
        switchSheet(+b.getAttribute('data-i'));
      });
    });
  }

  function switchSheet(i) {
    if (i === S.sheetIdx) return;
    S.sheetIdx = i;
    Store.touch(S.model.id, i);
    Grid.showSheet(i);
    renderTabs(); renderSide();
  }

  /* ------------------------------------------------------------ 表格挂载 */
  function mountGrid() {
    const wrap = document.getElementById('sheetWrap');
    Grid.mount(wrap, {
      model: S.model,
      sheetIdx: S.sheetIdx,
      inputs: S.inputs,
      revealed: Store.model(S.model.id).revealed || {},
      getWb: function () { return S.wb; },
      getSol: function () { return S.sol; },
      showChecks: function () { return S.showChecks; },
      fmtVal: fmtVal,
      onChange: function (sheetName, col, row, val) { setInput(sheetName, col, row, val); },
      onSelect: function (info) { S.actInfo = info; syncFx(); renderSide(); },
      onMessage: function (msg) { setStatus(msg); },
      getFx: function () { return document.getElementById('fxInput'); },
      onSheetChange: function (i) { switchSheet(i); },
      onEditState: function (e) { S.editState = e; renderTabs(); syncFx(); }
    });
  }

  function setStatus(msg) {
    const el2 = document.getElementById('gridStatus');
    if (!el2) return;
    el2.textContent = msg;
    clearTimeout(setStatus._t);
    setStatus._t = setTimeout(function () { el2.textContent = ''; }, 3000);
  }

  function syncFx() {
    const fx = document.getElementById('fxInput');
    const ad = document.getElementById('fxAddr');
    if (!fx || !ad) return;

    /* 正在编辑时，公式栏始终服务于编辑目标（可能在别的工作表上） */
    const ed = Grid.isEditing && Grid.isEditing() ? Grid.editInfo() : null;
    if (ed) {
      fx.disabled = false;
      ad.innerHTML = (ed.remote ? '<span class="fx-remote">' + esc(ed.sheetName) + '!</span>' : '') + esc(ed.addr);
      ad.title = ed.remote ? '正在编辑「' + ed.sheetName + '」的 ' + ed.addr + '，按 Enter 提交并跳回' : '';
      const bar = document.querySelector('.fx-bar');
      if (bar) bar.classList.toggle('remote', !!ed.remote);
      return;
    }
    const bar = document.querySelector('.fx-bar');
    if (bar) bar.classList.remove('remote');

    const info = S.actInfo;
    if (!info) { ad.textContent = '—'; fx.value = ''; fx.disabled = true; return; }
    const n = info.range;
    const multi = (n.c2 - n.c1 + 1) * (n.r2 - n.r1 + 1) > 1;
    ad.textContent = info.addr + (multi ? '  (' + (n.r2 - n.r1 + 1) + '×' + (n.c2 - n.c1 + 1) + ')' : '');
    fx.dataset.dirty = '0';
    if (info.kind === 'input') {
      fx.disabled = false;
      fx.value = info.raw || '';
      fx.placeholder = '写公式，例如 =B3-B6；引用其他表用 =\'假设\'!B3';
    } else {
      fx.disabled = true;
      fx.value = info.kind === 'given' ? '真实数据（只读）' : info.kind === 'calc' ? info.raw + '   （模型自带的计算格，只读）' : '';
    }
  }

  function setInput(sheetName, col, row, val) {
    const key = sheetName + '!' + FML.addr(col, row);
    const v = String(val === undefined || val === null ? '' : val).trim();
    if ((S.inputs[key] || '') === v) return;
    if (v === '') delete S.inputs[key]; else S.inputs[key] = v;
    Store.setInput(S.model.id, key, v, { sheet: S.sheetIdx });
    updateProgress();
    flashSaved();
  }

  function flashSaved() {
    const d = document.getElementById('saveDot');
    if (!d) return;
    d.classList.add('pending');
    d.querySelector('span').textContent = '保存中…';
    clearTimeout(flashSaved._t);
    flashSaved._t = setTimeout(function () {
      d.classList.remove('pending');
      d.querySelector('span').textContent = '已保存 · ' + fullTime(Store.model(S.model.id).updatedAt).slice(11);
    }, 320);
  }

  function scoreAll() {
    const m = S.model;
    S.wb.reset(); S.sol.reset();
    let correct = 0, total = 0;
    m.sheets.forEach(function (sh) {
      sh.rows.forEach(function (r, ri) {
        const rowNum = ri + 2;
        (r.cells || []).forEach(function (cell, ci) {
          if (!cell || cell.kind !== 'input') return;
          total++;
          const col = ci + 1;
          const key = sh.name + '!' + FML.addr(col, rowNum);
          if (!S.inputs[key]) return;
          const a = S.wb.tryGet(sh.name, col, rowNum);
          const b = S.sol.tryGet(sh.name, col, rowNum);
          if (a.ok && b.ok && nearEnough(a.v, b.v)) correct++;
        });
      });
    });
    return { correct: correct, total: total };
  }

  function updateProgress() {
    const s = scoreAll();
    Store.setProgress(S.model.id, s.correct, s.total);
    return s;
  }

  function checkAll() {
    S.showChecks = true;
    const s = updateProgress();
    Grid.refresh(); renderSide();
    if (s.correct === s.total) toast('全部正确，' + s.total + ' / ' + s.total + ' 🎉', 'ok');
    else toast('答对 ' + s.correct + ' / ' + s.total + '，点红色格子看诊断', s.correct ? '' : 'err');
  }

  function showHint() {
    const info = S.actInfo;
    if (!info || info.kind !== 'input') { toast('先选中一个待填单元格'); return; }
    S.hintFor = info.addr;
    renderSide();
  }

  function revealCurrent() {
    const info = S.actInfo;
    if (!info || info.kind !== 'input') { toast('先选中一个待填单元格'); return; }
    const key = info.sheet + '!' + info.addr;
    setInput(info.sheet, info.col, info.row, info.def.sol);
    Store.markRevealed(S.model.id, key);
    Grid.refresh(); syncFx(); renderSide();
    toast('已填入参考公式');
  }

  /* ------------------------------------------------------------ 侧栏渲染 */
  function renderSide() {
    const m = S.model;
    const side = document.getElementById('labSide');
    if (!side) return;
    const s = scoreAll();
    const pct = s.total ? Math.round(s.correct / s.total * 100) : 0;
    const rec = Store.model(m.id);

    /* 答错诊断：只在「检查」之后、且当前格确实错了的时候出现 */
    let diagHTML = '';
    const di = S.actInfo;
    if (S.showChecks && di && di.kind === 'input' && di.def && window.Diag) {
      const sh = m.sheets[S.sheetIdx];
      const key = sh.name + '!' + di.addr;
      const raw = S.inputs[key] || '';
      if (raw) {
        S.wb.reset(); S.sol.reset();
        const ur = S.wb.tryGet(sh.name, di.col, di.row);
        const sr = S.sol.tryGet(sh.name, di.col, di.row);
        if (sr.ok && !(ur.ok && nearEnough(ur.v, sr.v))) {
          const list = Diag.analyze({
            sheetName: sh.name, label: di.label,
            userRaw: raw, userVal: ur.ok ? ur.v : null, userErr: ur.ok ? null : ur.err,
            solRaw: di.def.sol, solVal: sr.v,
            evalIn: function (f) {
              try {
                return FML.evaluate(FML.compile(String(f).replace(/^=/, '')),
                  { sheet: sh.name, get: S.wb.get.bind(S.wb) });
              } catch (e) { return null; }
            }
          });
          diagHTML = '<div class="side-sec"><div class="st">诊断 · ' + esc(di.addr) + '</div>' +
            '<div class="diag-box">' +
              '<div class="diag-cmp"><span>你的结果</span><b class="bad">' + esc(fmtVal(ur.ok ? ur.v : '#ERR', di.def.fmt)) + '</b>' +
              '<span>参考答案</span><b class="ok">' + esc(fmtVal(sr.v, di.def.fmt)) + '</b></div>' +
              list.map(function (x, i) {
                return '<div class="diag-item"' + (i === 0 ? ' data-top="1"' : '') + '>' +
                  '<b>' + esc(x.t) + '</b><span>' + esc(x.d) + '</span></div>';
              }).join('') +
            '</div></div>';
        }
      }
    }

    let hintHTML = '';
    const info = S.actInfo;
    if (info && info.kind === 'input' && info.def) {
      const showF = S.hintFor === info.addr;
      hintHTML = '<div class="side-sec"><div class="st">当前单元格</div><div class="hint-box">' +
        '<div class="hb-addr">' + esc(info.sheet) + '!' + esc(info.addr) + '</div>' +
        '<div style="margin-top:4px"><b>' + esc(info.label) + '</b> · ' + esc(info.header) + '</div>' +
        (showF ? '<div style="margin-top:8px">参考公式：</div><div class="formula-pill">' + esc(info.def.sol) + '</div>'
               : '<div style="margin-top:8px;color:var(--ink-3);font-size:12.5px">点上方「提示」查看参考公式，或自己先试试。' +
                 '写公式时用鼠标点其他格可以直接插入引用；拖右下角小方块可以整行整列填充。</div>') +
        '</div></div>';
    }

    /* 在主线上的位置 + 下一步 */
    const pidx = DB.pathIndex ? DB.pathIndex()[m.id] : null;
    let pathHTML = '';
    if (pidx) {
      const nextId = DB.nextInPath(m.id);
      const nx = nextId ? byId(DB.models, nextId) : null;
      const finished = s.total > 0 && s.correct >= s.total;
      pathHTML = '<div class="side-sec"><div class="st">学习路径</div>' +
        '<a class="pt-where" href="#/path">阶段 ' + pidx.stageNo + '「' + esc(pidx.stage.name) + '」· 第 ' + pidx.stepNo + ' 步' +
        '<span>全程第 ' + pidx.overall + ' / ' + pidx.total + ' 步</span></a>' +
        '<div class="pt-note">' + esc(pidx.note) + '</div>' +
        (nx ? '<a class="btn ' + (finished ? 'primary' : '') + ' pt-next" href="#/model/' + nx.id + '">' +
          (finished ? '下一步：' : '下一步（未完成）：') + esc(nx.title) + ' →</a>'
          : '<div class="footnote" style="margin-top:8px">这是主线的最后一步。</div>') +
        '</div>';
    }

    side.innerHTML =
      '<div class="side-sec">' +
        '<div class="progress-line"><span>进度</span><div class="bar' + (pct >= 100 ? ' done' : '') + '"><i style="width:' + pct + '%"></i></div><span class="num">' + s.correct + '/' + s.total + '</span></div>' +
        '<div class="footnote" style="margin-top:6px">最后修改：' + fullTime(rec.updatedAt) + '</div>' +
      '</div>' +
      diagHTML +
      pathHTML +
      hintHTML +
      '<div class="side-sec"><div class="st">这个模型在干什么</div>' +
        m.intro.split('\n\n').map((p) => '<p style="font-size:13px;color:var(--ink-2)">' + esc(p).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>') + '</p>').join('') +
      '</div>' +
      '<div class="side-sec"><div class="st">操作步骤</div>' +
        m.steps.map((st, i) => '<div class="step"><div class="n">' + (i + 1) + '</div><div><b>' + esc(st.t) + '</b><br>' + esc(st.d) + '</div></div>').join('') +
      '</div>' +
      '<div class="side-sec"><div class="st">学习目标</div><ul style="padding-left:18px;margin:0;font-size:13px;color:var(--ink-2)">' +
        m.objectives.map((o) => '<li style="margin-bottom:5px">' + esc(o) + '</li>').join('') + '</ul></div>' +
      '<div class="side-sec"><div class="st">做完之后应该看懂什么</div>' +
        m.takeaways.map((t) => '<div class="callout info" style="font-size:12.5px">' + esc(t) + '</div>').join('') +
      '</div>' +
      '<div class="side-sec"><div class="st">数据说明</div><div class="footnote">' + esc(m.dataNote) + '</div></div>' +
      (m.companyId ? '<div class="side-sec"><a class="btn" style="width:100%;justify-content:center" href="#/company/' + m.companyId + '">查看公司案例背景与财报分析 →</a></div>' : '');
  }

  /* =========================================================================
   * 开发用：全量校验（浏览器控制台执行 validateAll()）
   * =======================================================================*/
  window.validateAll = function (verbose) {
    const problems = [];
    const report = [];
    DB.models.forEach(function (m) {
      const sol = new FML.Workbook(m, makeGetter(m, {}, true));
      const map = {}; m.sheets.forEach((s) => { map[s.name] = s; });
      const vals = [];
      m.sheets.forEach(function (sh) {
        sh.rows.forEach(function (r, ri) {
          const rowNum = ri + 2;
          (r.cells || []).forEach(function (cell, ci) {
            if (!cell || cell.kind !== 'input') return;
            const col = ci + 1;
            const a = sh.name + '!' + FML.addr(col, rowNum);
            const res = sol.tryGet(sh.name, col, rowNum);
            if (!res.ok) { problems.push({ model: m.id, cell: a, label: r.label, sol: cell.sol, err: res.err }); return; }
            if (typeof res.v !== 'number' || !isFinite(res.v)) {
              problems.push({ model: m.id, cell: a, label: r.label, sol: cell.sol, err: '结果不是有限数值: ' + res.v });
              return;
            }
            /* 引用了空白/分节行 => 大概率行号写错 */
            (FML.refsOf(String(cell.sol).replace(/^=/, ''), sh.name) || []).forEach(function (ref) {
              const pp = ref.split('!');
              const tsh = map[pp[0]];
              if (!tsh) { problems.push({ model: m.id, cell: a, label: r.label, sol: cell.sol, err: '引用了不存在的表: ' + pp[0] }); return; }
              const pa = /^([A-Z]+)([0-9]+)$/.exec(pp[1]);
              const tcol = FML.colToIdx(pa[1]), trow = parseInt(pa[2], 10);
              if (trow === 1) return;
              const tr = tsh.rows[trow - 2];
              if (!tr) { problems.push({ model: m.id, cell: a, label: r.label, sol: cell.sol, err: '引用了不存在的行: ' + ref }); return; }
              if (tr.style === 'sec' || tr.style === 'gap') {
                problems.push({ model: m.id, cell: a, label: r.label, sol: cell.sol, err: '引用到了分节/空行: ' + ref + ' (' + (tr.label || '空行') + ')' });
                return;
              }
              const tc = (tr.cells || [])[tcol - 1];
              if (!tc || tc.kind === 'empty') {
                problems.push({ model: m.id, cell: a, label: r.label, sol: cell.sol, err: '引用到了空单元格: ' + ref + ' (' + tr.label + ')' });
              }
            });
            vals.push({ cell: a, label: r.label, col: sh.header[col], v: res.v, sol: cell.sol });
          });
        });
      });
      report.push({ model: m.id, title: m.title, cells: vals.length, values: vals });
    });
    console.log('%c校验完成：' + DB.models.length + ' 个模型，' + problems.length + ' 个问题', 'font-weight:bold;font-size:14px');
    if (problems.length) console.table(problems);
    if (verbose) report.forEach(function (r) { console.groupCollapsed(r.model + ' — ' + r.title + ' (' + r.cells + ')'); console.table(r.values); console.groupEnd(); });
    return { problems: problems, report: report };
  };

  window.dumpModel = function (id) {
    const m = byId(DB.models, id);
    if (!m) return '找不到';
    const sol = new FML.Workbook(m, makeGetter(m, {}, true));
    const out = [];
    m.sheets.forEach(function (sh) {
      sh.rows.forEach(function (r, ri) {
        const rowNum = ri + 2;
        const line = { sheet: sh.name, row: rowNum, label: r.label };
        for (let c = 1; c < sh.header.length; c++) {
          const cell = (r.cells || [])[c - 1];
          if (!cell || cell.kind === 'empty') { line[sh.header[c]] = ''; continue; }
          const res = sol.tryGet(sh.name, c, rowNum);
          line[sh.header[c]] = res.ok ? (typeof res.v === 'number' ? Math.round(res.v * 10000) / 10000 : res.v) : ('ERR:' + res.err);
        }
        out.push(line);
      });
    });
    console.table(out);
    return out;
  };

  /* =========================================================================
   * 启动
   * =======================================================================*/
  function boot() {
    if (DB.applyTypes) DB.applyTypes();
    /* theme = 'auto' 时不写 data-theme，交给 prefers-color-scheme 和宿主页面的切换器 */
    const th = Store.prefs().theme;
    if (th === 'dark' || th === 'light') document.documentElement.setAttribute('data-theme', th);
    window.addEventListener('hashchange', render);
    render();

    /* 账号是可选的：没配 config.js 就整块跳过 */
    if (window.Auth && Auth.enabled()) {
      Auth.init().then(function (u) {
        if (window.Sync) Sync.start();
        if (u) { render(); return Sync.pullAndMerge().then(function () { render(); }); }
      }).catch(function (e) { console.warn('账号初始化失败，已退回本地模式', e); });
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
