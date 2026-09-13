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

  /* 判定统一走 grade.js，容差也在那里定义，避免三处各写一份又互相飘。 */
  const nearEnough = Grade.near;

  /* =========================================================================
   * 应用状态
   * =======================================================================*/
  const S = {
    filterMarket: 'all', filterLevel: 'all', filterIndustry: 'all', q: '',
    model: null, sheetIdx: 0, actInfo: null, inputs: {}, wb: null, sol: null, grader: null,
    showChecks: false, hintFor: null, hintTier: 0, tab: 'task', startTs: 0
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
    if (S.model) commitPending();
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

  /* 下载被拦时的进度备份：把 JSON 放进文本框让用户复制。
     导入那边本来就接受粘贴的 JSON 文件，所以这段文字存成 .json 就能导回来。 */
  function showCopyBackup(json) {
    const wrap = document.createElement('div');
    wrap.className = 'modal-mask';
    wrap.innerHTML = '<div class="modal" style="max-width:560px">' +
      '<div class="mh"><h2 style="margin-bottom:2px">复制进度备份</h2>' +
        '<div style="font-size:12.5px;color:var(--ink-3)">这个页面跑在受限框架里，浏览器不让直接下载。' +
        '把下面的内容全选复制，存成一个 <code>.json</code> 文件，以后用「导入备份」就能恢复。</div></div>' +
      '<div class="mb">' +
        '<textarea id="bkText" readonly spellcheck="false" style="width:100%;height:220px;font-family:var(--mono);font-size:11.5px;' +
          'border:1px solid var(--border-strong);border-radius:8px;padding:8px 10px;background:var(--surface-2);color:var(--ink);resize:vertical"></textarea>' +
        '<div id="bkMsg" style="font-size:12px;color:var(--ink-3);margin-top:6px"></div>' +
      '</div>' +
      '<div class="mf">' +
        '<button class="btn" id="bkClose">关闭</button>' +
        '<button class="btn primary" id="bkCopy">复制到剪贴板</button>' +
      '</div></div>';
    document.body.appendChild(wrap);
    const ta = wrap.querySelector('#bkText');
    ta.value = json;
    const msg = wrap.querySelector('#bkMsg');
    const close = function () { wrap.remove(); };
    wrap.querySelector('#bkClose').onclick = close;
    wrap.onclick = function (e) { if (e.target === wrap) close(); };
    wrap.querySelector('#bkCopy').onclick = function () {
      ta.focus(); ta.select();
      const done = function () { msg.style.color = 'var(--ok)'; msg.textContent = '已复制 ' + json.length.toLocaleString() + ' 个字符'; };
      const fail = function () { msg.textContent = '自动复制被拦了——文本已全选，按 Ctrl/Cmd + C 手动复制'; };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(json).then(done, fail);
      } else {
        try { document.execCommand('copy') ? done() : fail(); } catch (e) { fail(); }
      }
    };
    setTimeout(function () { ta.focus(); ta.select(); }, 30);
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

  /** @param root 只绑定这棵子树；不传就绑定整页（局部刷新后要用它补绑新节点） */
  function bindCards(root) {
    const scopeEl = root || $app;
    Array.prototype.forEach.call(scopeEl.querySelectorAll('[data-goto]'), function (n) {
      n.onclick = function (e) { if (e.target.tagName === 'A') return; go(n.getAttribute('data-goto')); };
    });
    /* 轨道切换：换掉 DB.path 再重渲染即可，进度是按模型 id 存的，不受影响 */
    Array.prototype.forEach.call(scopeEl.querySelectorAll('[data-track]'), function (n) {
      n.onclick = function () {
        if (!DB.setTrack) return;
        DB.setTrack(n.getAttribute('data-track'));
        render();
        window.scrollTo(0, 0);
      };
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
        /* 还没选过轨道，就先让人选，而不是直接推荐一门 41.9 小时的完整主线。
           零基础轨道只有 6.1 小时——第一印象差别很大。 */
        if (!DB.trackChosen) {
          return '<div class="trk-pick-home">' +
            '<div class="tph-h"><div class="pc-k">先选一条路线</div>' +
            '<div class="pc-t">你现在是什么水平？</div>' +
            '<div class="pc-d">69 个训练不必都做。选一条最贴近你的，剩下的随时能换。</div></div>' +
            '<div class="tph-cards">' + DB.tracks.map(function (tk) {
              const n = []; tk.stages.forEach(function (sg) { sg.steps.forEach(function (x) { n.push(x.id); }); });
              const hh = n.reduce(function (a, id) { const mm = byId(DB.models, id); return a + (mm ? mm.minutes : 0); }, 0);
              return '<button class="tph-card" data-track="' + tk.id + '">' +
                '<b>' + esc(tk.name) + '</b>' +
                '<span class="tph-who">' + esc(tk.who || '') + '</span>' +
                '<span class="tph-n">' + n.length + ' 个训练 · 约 ' + (hh / 60).toFixed(1) + ' 小时</span>' +
                '</button>';
            }).join('') + '</div>' +
          '</div>';
        }
        return '<div class="path-cta">' +
          '<div class="pc-l">' +
            '<div class="pc-k">你的路线 · ' + esc((DB.getTrack() || {}).name || '') + '</div>' +
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

    const tk = DB.getTrack ? DB.getTrack() : null;
    const picker = !DB.tracks ? '' :
      '<div class="trk-pick">' +
        '<div class="trk-lab">选择适合你的路径</div>' +
        '<div class="trk-btns">' + DB.tracks.map(function (x) {
          return '<button class="trk' + (x.id === DB.currentTrack ? ' on' : '') + '" data-track="' + x.id + '">' +
            '<b>' + esc(x.name) + '</b><span>' + esc(x.who) + '</span></button>';
        }).join('') + '</div>' +
        (tk ? '<div class="trk-note"><b>' + esc(tk.goal) + '</b>' + esc(tk.note) + '</div>' : '') +
      '</div>';

    return '<div class="page-head">' +
        '<div class="eyebrow">学习路径</div><h1>' + esc(tk ? tk.name : '按顺序做完，就是一套完整的建模训练') + '</h1>' +
        '<div class="sub">路径按<b>能力</b>递进排列，不按模型类型。每一步都写了它在练什么、' +
        '为什么排在这个位置。<b>不要跳着做</b>：后面的训练会直接用到前面建立的直觉。' +
        '换轨道不会丢进度——所有轨道共用同一份作答记录。</div>' +
      '</div>' + picker +
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
  /* 按当前筛选条件算出模型列表。抽出来是为了让搜索能只刷新结果区，
     不必重渲染整页——重渲染会销毁输入框，中文输入法正在拼字时就会丢字。 */
  function browseList(scope) {
    let list = DB.models.slice();
    if (scope === 'secondary' || scope === 'primary') list = list.filter((m) => m.market === scope);
    if (S.filterLevel !== 'all') list = list.filter((m) => String(m.level) === S.filterLevel);
    if (S.filterIndustry !== 'all') list = list.filter((m) => m.industryId === S.filterIndustry);
    /* 69 个模型之后，只靠难度 + 行业两个下拉已经找不到东西了。
       搜索覆盖标题、副标题、标签、公司名、类型名，外加「30 分钟」这种时长写法。 */
    if (S.q) {
      const q = S.q.toLowerCase().trim();
      const mins = /^(\d+)\s*分钟?(以内|以下)?$/.exec(q);
      list = list.filter(function (m) {
        if (mins) return m.minutes <= parseInt(mins[1], 10);
        const co = m.companyId ? byId(DB.companies, m.companyId) : null;
        const ty = byId(DB.modelTypes, m.type);
        return [m.title, m.subtitle, (m.tags || []).join(' '), co && co.name, ty && ty.name, ty && ty.id, m.id]
          .filter(Boolean).join(' ').toLowerCase().indexOf(q) >= 0;
      });
    }
    list.sort((a, b) => (a.level - b.level) || a.title.localeCompare(b.title, 'zh'));
    return list;
  }

  function browseCards(list) {
    return list.length
      ? '<div class="grid-cards">' + list.map(modelCard).join('') + '</div>'
      : '<div class="empty"><div class="big">∅</div>没有符合条件的模型，换个筛选试试。</div>';
  }

  function viewBrowse(scope) {
    const list = browseList(scope);

    const title = scope === 'secondary' ? '二级市场模型' : scope === 'primary' ? '一级市场模型' : '全部模型';
    const desc = scope === 'secondary'
      ? '上市公司财报分析与估值。所有历史数据均来自公司年报 / Form 10-K，预测假设已在表内明确标注。'
      : scope === 'primary'
        ? '私募股权与并购交易建模。交易条款来自公开公告，未披露的融资细节以教学假设呈现并标注。'
        : '按市场、难度、行业筛选。点开任意模型即可开始，进度自动保存。';

    const seg = (id, cur, opts) => '<div class="seg" data-seg="' + id + '">' +
      opts.map((o) => '<button data-v="' + o.v + '"' + (cur === o.v ? ' class="on"' : '') + '>' + o.t + '</button>').join('') + '</div>';

    setTimeout(function () {
      const sb = document.getElementById('srch');
      if (sb) {
        /* 两件事一起解决中文输入：
           一、只刷新结果区，不重渲染整页——输入框自始至终是同一个 DOM 节点，
               不会在拼字过程中被销毁重建；
           二、compositionstart/end 期间不触发搜索。拼音输入法在选字之前，
               input 事件里拿到的是「zhongguo」这种中间态，拿它去搜没有意义，
               而且会让结果区乱跳。 */
        let composing = false;
        const run = function () {
          S.q = sb.value;
          const host = document.getElementById('browseResults');
          const cnt = document.getElementById('browseCount');
          if (!host) return;
          const ls = browseList(scope);
          host.innerHTML = browseCards(ls);
          if (cnt) cnt.textContent = '共 ' + ls.length + ' 个';
          bindCards(host);
        };
        sb.addEventListener('compositionstart', function () { composing = true; });
        sb.addEventListener('compositionend', function () { composing = false; run(); });
        sb.oninput = function () {
          if (composing) return;
          clearTimeout(sb._t);
          sb._t = setTimeout(run, 140);
        };
      }
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
        '<input class="srch" id="srch" type="search" placeholder="搜索：LBO / 苹果 / 商誉 / 营运资本 / 30 分钟" value="' + esc(S.q || '') + '">' +
        seg('level', S.filterLevel, [{ v: 'all', t: '全部难度' }, { v: '1', t: '简单' }, { v: '2', t: '中级' }, { v: '3', t: '复杂' }]) +
        seg('ind', S.filterIndustry, [{ v: 'all', t: '全部行业' }].concat(DB.industries.map((i) => ({ v: i.id, t: i.name })))) +
        '<span id="browseCount" style="margin-left:auto;font-size:12.5px;color:var(--ink-3)">共 ' + list.length + ' 个</span>' +
      '</div>' +
      '<div id="browseResults">' + browseCards(list) + '</div>';
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
            /* 分享版（制品）里浏览器会拦掉下载，但进度备份不能因此就没有——
               作答记录只存在这台浏览器的 localStorage 里，换设备或清缓存就没了。
               退回成一个可全选的文本框：粗糙，但 sandbox 拦不住它。 */
            if (err && err.code === 'sandboxed') { showCopyBackup(Store.exportJSON()); return; }
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
            try {
              const r = Store.importJSON(rd.result);
              toast('导入成功，' + r.models + ' 个模型的记录已恢复', 'ok'); render();
            } catch (e) { toast('导入失败，原有进度未改动：' + e.message, 'err', 9000); }
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
      '<li><b>绝对引用</b>：<code>=$B$25</code>。拖右下角填充柄、或按 <kbd>Ctrl</kbd>+<kbd>D</kbd> / <kbd>Ctrl</kbd>+<kbd>R</kbd> 填充时，' +
      '相对引用会跟着平移，加了 <code>$</code> 的部分不动——和 Excel 一致</li>' +
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
          /* 主次分明：检查是唯一的主行动，提示次一级，其余收进 ··· 菜单。
             「查看答案」刻意放在菜单最下面并做成危险色——它和「提示」不是同级操作，
             并排摆会诱导人先点答案。 */
          '<button class="btn sm" id="btnSide">说明</button>' +
          '<button class="btn sm" id="btnHint">提示</button>' +
          '<div class="more-wrap">' +
            '<button class="btn sm" id="btnMore" aria-haspopup="true" aria-expanded="false">···</button>' +
            '<div class="more-menu" id="moreMenu" hidden>' +
              '<button id="btnXlsx">导出 Excel</button>' +
              '<button id="btnReset">重置本模型</button>' +
              '<button id="btnRestore">恢复上次存档</button>' +
              '<div class="more-sep"></div>' +
              '<button id="btnReveal" class="danger">查看答案</button>' +
            '</div>' +
          '</div>' +
          '<button class="btn primary sm" id="btnCheck">检查全部</button>' +
        '</div>' +
        /* 手机端明确定位成学习/复习，而不是假装能在 390px 上建模。
           公式栏、跨列比较、键盘导航在手机上都不成立，与其硬塞不如说清楚。 */
        '<div class="mobile-note">手机适合看说明、步骤和错误诊断。' +
          '真正动手填公式建议用电脑——需要键盘和横向视野。</div>' +
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
      closeMore();
      if (!confirm('重置本模型？作答、提示和尝试记录都会清零，相当于重新练一遍。\n重置前会自动存一个还原点，可以从「···」里恢复。')) return;
      Store.resetModel(m.id); S.inputs = {}; rebuild(); mountGrid(); renderSide(); toast('已重置，还原点已存');
    };
    /* 还原点以前只存不读——存储层有 restore()，界面却没有任何入口 */
    document.getElementById('btnRestore').onclick = function () {
      closeMore();
      const snaps = Store.model(m.id).snapshots || [];
      if (!snaps.length) { toast('还没有存档可恢复'); return; }
      const s = snaps[0];
      const n = Object.keys(s.inputs || {}).length;
      if (!confirm('恢复到「' + s.note + '」（' + fullTime(s.ts) + '，' + n + ' 格作答）？\n当前的作答会被覆盖，但会先自动存一个还原点。')) return;
      Store.snapshot(m.id, '恢复前自动存档');
      /* 刚存的那条排在 [0]，要恢复的变成 [1] */
      if (!Store.restore(m.id, 1)) { toast('恢复失败', 'err'); return; }
      S.inputs = Store.model(m.id).inputs;
      rebuild(); mountGrid(); updateProgress(); renderSide();
      toast('已恢复 ' + n + ' 格作答', 'ok');
    };
    document.getElementById('btnXlsx').onclick = function (e) {
      closeMore();
      commitPending();
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
    document.getElementById('btnReveal').onclick = function () { closeMore(); revealCurrent(); };
    document.getElementById('btnMore').onclick = function (e) {
      e.stopPropagation();
      const mm = document.getElementById('moreMenu');
      const open = mm.hasAttribute('hidden');
      if (open) { mm.removeAttribute('hidden'); } else { mm.setAttribute('hidden', ''); }
      this.setAttribute('aria-expanded', open ? 'true' : 'false');
    };
    document.addEventListener('click', closeMore);
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

  /* 把正在编辑但还没按回车的公式先提交掉。
     检查、导出、离开模型之前都要调——否则学生在公式栏敲完最后一格直接点
     「检查全部」，那一格既不参与检查，返回后还会丢。
     公式栏聚焦本身就会开始编辑，所以 blur 里那条 !Grid.isEditing() 的守卫
     在这条路径上永远不成立，等于从没提交过。 */
  function commitPending() {
    if (!window.Grid) return false;
    if (Grid.isEditing && Grid.isEditing()) { Grid.commitEdit(); return true; }
    const fx = document.getElementById('fxInput');
    if (fx && !fx.disabled && fx.dataset.dirty === '1') { applyFx(); return true; }
    return false;
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
    S.grader = Grade.build(m, S.inputs);
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
      getGrader: function () { return S.grader; },
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

  /**
   * @param source 'user' | 'reveal' | 'restore' —— 这个值决定要不要记尝试。
   *   以前靠「修改前 revealed 有没有置位」来推断来源，而 revealCurrent 是
   *   先 setInput 再 markRevealed，于是看答案那一刻被当成了用户的首次作答，
   *   还记成了首次正确。来源必须由调用方显式声明，不能事后推断。
   */
  function setInput(sheetName, col, row, val, source) {
    source = source || 'user';
    const key = sheetName + '!' + FML.addr(col, row);
    const v = String(val === undefined || val === null ? '' : val).trim();
    if ((S.inputs[key] || '') === v) return;
    if (v === '') delete S.inputs[key]; else S.inputs[key] = v;
    Store.setInput(S.model.id, key, v, { sheet: S.sheetIdx });
    S.wb.reset(); S.sol.reset(); S.grader.reset();
    /* 记录尝试与首次结果。首次正确率是学习分析里信息量最大的单一指标，
       而且只有在这里能拿到——判定完成之后再回头统计是补不出来的。
       只有用户自己提交的才算：清空不算，看答案不算，恢复存档不算。 */
    if (source === 'user' && v !== '' && !Store.model(S.model.id).revealed[key]) {
      Store.bumpAttempt(S.model.id, key);
      Store.markFirstResult(S.model.id, key, S.grader.of(sheetName, col, row).ok);
    }
    updateProgress();
    flashSaved();
  }

  /* 「已保存」由存储层的真实写入结果驱动，不再是 320ms 定时器到点就变绿。
     写入失败时红点常驻、文字说明原因，并把「导出备份」当出路指出来——
     内存里的进度还在，只是落不了盘。 */
  function flashSaved() {
    const d = document.getElementById('saveDot');
    if (!d) return;
    d.classList.remove('failed');
    d.classList.add('pending');
    d.querySelector('span').textContent = '保存中…';
  }
  function paintSaveState(st) {
    const d = document.getElementById('saveDot');
    if (!d || !S.model) return;
    d.classList.remove('pending');
    if (st.ok) {
      d.classList.remove('failed');
      d.querySelector('span').textContent = '已保存 · ' + fullTime(st.at).slice(11);
      d.title = '';
    } else {
      d.classList.add('failed');
      d.querySelector('span').textContent = '未保存：' + st.err;
      d.title = '这次改动没有写进浏览器。可以先从进度页「导出备份」把当前进度存成文件。';
      if (!paintSaveState._warned) {
        paintSaveState._warned = true;
        toast('进度保存失败：' + st.err + '。内存里的作答还在，建议立刻从进度页导出备份。', 'err', 12000);
      }
    }
  }
  Store.onSave(paintSaveState);

  function scoreAll() {
    /* 判定结果在 grader 里按格缓存，只有 setInput 会让它失效。
       renderSide 每次选格都会调到这里，不能每次都重算全表。 */
    const mid = S.model.id;
    return S.grader.scan(function (key) { return Store.isSolo(mid, key); });
  }

  function updateProgress() {
    const s = scoreAll();
    Store.setProgress(S.model.id, s.correct, s.total);
    return s;
  }

  function checkAll() {
    commitPending();
    S.showChecks = true;
    const s = updateProgress();
    Grid.refresh(); renderSide();
    if (s.correct === s.total) toast('全部正确，' + s.total + ' / ' + s.total + ' 🎉', 'ok');
    else toast('答对 ' + s.correct + ' / ' + s.total + '，点红色格子看诊断', s.correct ? '' : 'err');
  }

  function closeMore() {
    const mm = document.getElementById('moreMenu');
    if (mm && !mm.hasAttribute('hidden')) {
      mm.setAttribute('hidden', '');
      const b = document.getElementById('btnMore');
      if (b) b.setAttribute('aria-expanded', 'false');
    }
  }

  /* 提示逐级放出，每一级都记录。换一个格子时层级归零。
     记录必须在内容真的显示之后：手机上侧栏默认收起，以前点一次提示什么都看不到，
     但层级已经 +1 并扣掉了独立掌握资格——用户被扣了分却没得到任何东西。 */
  function showHint() {
    const info = S.actInfo;
    if (!info || info.kind !== 'input') { toast('先选中一个待填单元格'); return; }
    const sh = S.model.sheets[S.sheetIdx];
    const key = sh.name + '!' + info.addr;
    if (S.hintFor !== info.addr) { S.hintFor = info.addr; S.hintTier = 0; }
    /* 先把侧栏打开并切到「提示与诊断」。侧栏收起时这一次点击只负责打开，
       不升级、不记录——让用户先看到已有的内容，再决定要不要下一级。 */
    const side = document.getElementById('labSide');
    const wasCollapsed = side && side.classList.contains('collapsed');
    if (wasCollapsed) side.classList.remove('collapsed');
    S.tab = 'fb';
    if (wasCollapsed && S.hintTier > 0) { renderSide(); return; }
    if (S.hintTier >= Hint.MAX) {
      toast('提示已经给到最后一级了。还是没头绪的话，从「···」里查看答案', 'warn', 5000);
      renderSide(); return;
    }
    S.hintTier++;
    renderSide();
    /* 渲染完再确认这一级真的在页面上，确认了才记账 */
    const shown = side && !side.classList.contains('collapsed') &&
      document.querySelectorAll('.hint-tier').length >= S.hintTier;
    if (shown) Store.markHint(S.model.id, key, S.hintTier);
    else S.hintTier--;
    if (shown && S.hintTier === Hint.MAX) toast('这是最后一级提示', 'warn');
  }

  function revealCurrent() {
    const info = S.actInfo;
    if (!info || info.kind !== 'input') { toast('先选中一个待填单元格'); return; }
    const key = info.sheet + '!' + info.addr;
    /* 二次确认：看答案是有代价的，这一格从此不计入独立掌握度。
       摩擦本身就是目的——不加确认，「查看答案」会变成默认动作。 */
    if (!Store.model(S.model.id).revealed[key]) {
      const tier = Store.model(S.model.id).hints[key] || 0;
      const msg = '看过答案之后，这一格就不再计入「独立掌握度」（完成度不受影响）。' +
        (tier < Hint.MAX ? '\n\n提示还有第 ' + (tier + 1) + ' 级没用，要不要先试试？' : '') +
        '\n\n确定要看答案吗？';
      if (!window.confirm(msg)) return;
    }
    /* 先标记再填入，且来源显式为 reveal——两道保险，哪一道漏了都不会把
       看答案记成用户作答。 */
    Store.markRevealed(S.model.id, key);
    setInput(info.sheet, info.col, info.row, info.def.sol, 'reveal');
    Grid.refresh(); syncFx(); renderSide();
    toast('已填入参考公式，这一格不计入独立掌握度', 'warn', 5000);
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
        const vd = S.grader.of(sh.name, di.col, di.row);
        const sr = S.sol.tryGet(sh.name, di.col, di.row);
        if (sr.ok && !vd.ok) {
          const ur = S.wb.tryGet(sh.name, di.col, di.row);
          /* 格式写在行上、单元格可以覆盖，和表格渲染取的是同一条规则 */
          const dfmt = cellFmt(sh, sh.rows[di.row - 2] || {}, di.def);
          const list = Diag.analyze({
            sheetName: sh.name, label: di.label,
            userRaw: raw, userVal: ur.ok ? ur.v : null, userErr: ur.ok ? null : ur.err,
            solRaw: di.def.sol, solVal: sr.v,
            verdict: vd.code, refVal: vd.refVal, yourVal: vd.yourVal,
            bounds: di.def.bounds, boundsNote: di.def.boundsNote,
            fmtVal: function (v) { return fmtVal(v, dfmt); },
            evalIn: function (f) {
              try {
                return FML.evaluate(FML.compile(String(f).replace(/^=/, '')),
                  { sheet: sh.name, get: S.wb.get.bind(S.wb) });
              } catch (e) { return null; }
            }
          });
          /* 值本身是对的（写死 / 公式不等价）时，别把它显示成红色的「你的结果」，
             那会让学生以为数算错了，而错的其实是得到这个数的方式。 */
          const valueRight = (vd.code === 'const' || vd.code === 'nonequiv');
          diagHTML = '<div class="side-sec"><div class="st">诊断 · ' + esc(di.addr) + '</div>' +
            '<div class="diag-box">' +
              '<div class="diag-cmp"><span>你的结果</span><b class="' + (valueRight ? 'ok' : 'bad') + '">' +
                esc(fmtVal(ur.ok ? ur.v : '#ERR', dfmt)) + '</b>' +
              '<span>参考答案</span><b class="ok">' + esc(fmtVal(sr.v, dfmt)) + '</b></div>' +
              list.map(function (x, i) {
                return '<div class="diag-item"' + (i === 0 ? ' data-top="1"' : '') + '>' +
                  '<b>' + esc(x.t) + '</b><span>' + esc(x.d) + '</span></div>';
              }).join('') +
            '</div></div>';
        }
      }
    }

    /* 当前单元格：三级提示，逐级放出。
       以前这里直接显示完整参考公式，而且不做记录——等于一个不记账的答案按钮。 */
    let hintHTML = '';
    const info = S.actInfo;
    if (info && info.kind === 'input' && info.def) {
      const shx = m.sheets[S.sheetIdx];
      const ckey = shx.name + '!' + info.addr;
      const rec2 = Store.model(m.id);
      const usedTier = (S.hintFor === info.addr) ? S.hintTier : 0;
      const savedTier = rec2.hints[ckey] || 0;
      const wasRevealed = !!rec2.revealed[ckey];
      const tries = rec2.attempts[ckey] || 0;

      let tiers = '';
      for (let k = 1; k <= usedTier; k++) {
        const h = Hint.of(m, shx, info.col, info.row, k);
        if (!h) continue;
        tiers += '<div class="hint-tier"><div class="ht-h"><span class="ht-n">' + k + '</span>' + esc(h.title) + '</div>' +
          '<div class="ht-b">' + esc(h.body) + '</div>' +
          (h.step ? '<div class="ht-step">' + esc(h.step) + '</div>' : '') +
          (h.refs ? '<ul class="ht-refs">' + h.refs.map(function (r) {
            return '<li>' + (r.cross ? '<span class="ht-x">跨表</span>' : '') + esc(r.label) + '</li>';
          }).join('') + '</ul>' : '') +
          (h.skeleton ? '<div class="formula-pill">' + esc(h.skeleton) + '</div>' : '') +
          '</div>';
      }

      const meta = [];
      if (tries) meta.push('已提交 ' + tries + ' 次');
      if (savedTier) meta.push('用过 ' + savedTier + ' 级提示');
      if (wasRevealed) meta.push('看过答案');

      hintHTML = '<div class="side-sec"><div class="st">当前单元格</div><div class="hint-box">' +
        '<div class="hb-addr">' + esc(info.sheet) + '!' + esc(info.addr) + '</div>' +
        '<div style="margin-top:4px"><b>' + esc(info.label) + '</b> · ' + esc(info.header) + '</div>' +
        (meta.length ? '<div class="hb-meta">' + esc(meta.join(' · ')) + '</div>' : '') +
        tiers +
        (usedTier < Hint.MAX
          ? '<div class="hb-more">点上方「提示」' + (usedTier ? '看第 ' + (usedTier + 1) + ' 级' : '获取第 1 级提示') +
            '（共 ' + Hint.MAX + ' 级，用到 2 级以上就不算独立完成）</div>'
          : '<div class="hb-more">提示已用尽。仍没头绪就从「···」查看答案。</div>') +
        (wasRevealed ? '<div style="margin-top:8px">参考公式：</div><div class="formula-pill">' + esc(info.def.sol) + '</div>' : '') +
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

    /* 完成度和独立掌握度分开显示。
       只有 correct/total 的话，一路看答案填完也是 100%——那个数字没有信息量。 */
    const soloPct = s.total ? Math.round(s.soloCorrect / s.total * 100) : 0;
    const rec3 = Store.model(m.id);
    const nHint = Object.keys(rec3.hints || {}).length;
    const nSeen = Object.keys(rec3.revealed || {}).length;
    const firstVals = Object.keys(rec3.firstOk || {});
    const firstOkN = firstVals.filter(function (k) { return rec3.firstOk[k]; }).length;

    const progHTML = '<div class="side-sec">' +
      '<div class="progress-line"><span>完成度</span><div class="bar' + (pct >= 100 ? ' done' : '') + '"><i style="width:' + pct + '%"></i></div><span class="num">' + s.correct + '/' + s.total + '</span></div>' +
      '<div class="progress-line" style="margin-top:6px"><span>独立掌握</span><div class="bar solo"><i style="width:' + soloPct + '%"></i></div><span class="num">' + soloPct + '%</span></div>' +
      '<div class="footnote" style="margin-top:7px">' +
        (firstVals.length ? '首次正确 ' + firstOkN + '/' + firstVals.length + ' 格' : '还没有作答记录') +
        (nHint ? ' · ' + nHint + ' 格用过提示' : '') +
        (nSeen ? ' · ' + nSeen + ' 格看过答案' : '') +
      '</div>' +
      '<div class="footnote" style="margin-top:4px">最后修改：' + fullTime(rec.updatedAt) + '</div>' +
    '</div>';

    /* 三个 Tab：做题时不该被九个板块同时轰炸。
       任务 = 我现在该干什么；反馈 = 这一格怎么了；资料 = 背景知识，需要时再看。 */
    const TABS = [{ id: 'task', n: '任务' }, { id: 'fb', n: '提示与诊断' }, { id: 'doc', n: '案例资料' }];
    const tabBar = '<div class="side-tabs">' + TABS.map(function (x) {
      return '<button class="' + (S.tab === x.id ? 'on' : '') + '" data-tab="' + x.id + '">' + x.n +
        (x.id === 'fb' && diagHTML ? '<i class="dot"></i>' : '') + '</button>';
    }).join('') + '</div>';

    const paneTask = progHTML + pathHTML +
      '<div class="side-sec"><div class="st">操作步骤</div>' +
        m.steps.map((x, i) => '<div class="step"><div class="n">' + (i + 1) + '</div><div><b>' + esc(x.t) + '</b><br>' + esc(x.d) + '</div></div>').join('') +
      '</div>';

    const paneFb = hintHTML + diagHTML +
      (diagHTML || hintHTML ? '' : '<div class="side-sec"><div class="footnote">选中一个待填单元格，这里会显示提示；点「检查全部」之后，答错的格子会显示诊断。</div></div>');

    const paneDoc =
      '<div class="side-sec"><div class="st">这个模型在干什么</div>' +
        m.intro.split('\n\n').map((p) => '<p style="font-size:13px;color:var(--ink-2)">' + esc(p).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>') + '</p>').join('') +
      '</div>' +
      '<div class="side-sec"><div class="st">学习目标</div><ul style="padding-left:18px;margin:0;font-size:13px;color:var(--ink-2)">' +
        m.objectives.map((o) => '<li style="margin-bottom:5px">' + esc(o) + '</li>').join('') + '</ul></div>' +
      '<div class="side-sec"><div class="st">做完之后应该看懂什么</div>' +
        m.takeaways.map((t) => '<div class="callout info" style="font-size:12.5px">' + esc(t) + '</div>').join('') +
      '</div>' +
      '<div class="side-sec"><div class="st">数据说明</div>' +
        provHTML(m) +
        '<div class="footnote">' + esc(m.dataNote) + '</div></div>' +
      (m.companyId ? '<div class="side-sec"><a class="btn" style="width:100%;justify-content:center" href="#/company/' + m.companyId + '">查看公司案例背景与财报分析 →</a></div>' : '');

    side.innerHTML = tabBar + '<div class="side-pane">' +
      (S.tab === 'fb' ? paneFb : S.tab === 'doc' ? paneDoc : paneTask) + '</div>';

    Array.prototype.forEach.call(side.querySelectorAll('[data-tab]'), function (b) {
      b.onclick = function () { S.tab = b.getAttribute('data-tab'); renderSide(); };
    });
  }

  /* 数据口径条。币种、量级、财年口径全部从 sheet.unit 和表头推出来，
     不是手写的，所以不会写着写着和数据对不上。
     只有人能填的部分（原文链接、页码、截止日）如实标「未标注」，不编。 */
  function provHTML(m) {
    if (!window.Prov) return '';
    const line = Prov.summary(m);
    const src = m.source || {};
    let html = '';
    if (line) html += '<div class="prov-line">' + esc(line) + '</div>';
    if (src.docs && src.docs.length) {
      html += '<div class="prov-docs">' + src.docs.map(function (d) {
        const bits = [d.title, d.period, d.statement, d.page ? '第 ' + d.page + ' 页' : null]
          .filter(Boolean).map(esc).join(' · ');
        /* 「已核对」和「照抄自数据说明」必须分开标。
           一条没人核过的来源，看起来和核过的一模一样，那这套溯源就是装饰。 */
        const mark = d.verified
          ? '<span class="prov-ok" title="已对着原文核对">✓ 已核对</span>'
          : '<span class="prov-un" title="来源已标注，但尚未对着原文逐项核对">待核对</span>';
        return d.url
          ? '<div><a href="' + esc(d.url) + '" target="_blank" rel="noopener">' + bits + ' ↗</a> ' + mark + '</div>'
          : '<div>' + bits + ' ' + mark + '</div>';
      }).join('') + '</div>';
    }
    /* 缺口只在「已经声明了 source 但填了一半」时提示。
       一个 source 都没声明的模型不在这里唠叨——56 个模型页页挂一行警告是噪声，
       那份清单属于开发期的 verifySource()，是拿来干活的，不是拿来给学生看的。 */
    if (m.source) {
      const gaps = Prov.gaps(m);
      if (gaps.length) html += '<div class="prov-gap">溯源信息未标注：' + esc(gaps.join('、')) + '</div>';
    }
    return html;
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
    /* 刷新 / 关闭标签页前把编辑中的公式提交掉，并**立刻落盘**。
     store.js 自己的 beforeunload 注册得更早、跑得也更早，所以它 flush 的时候
     这里还没提交；提交走的又是 250ms 延迟保存，页面已经没了。
     两个事件都挂：移动端 Safari 不触发 beforeunload，桌面端 pagehide 有时不触发。
     flush 是幂等的，跑两遍没有副作用。 */
  function commitAndFlush() {
    if (!S.model) return;
    if (commitPending()) Store.flush();
  }
  window.addEventListener('pagehide', commitAndFlush);
  window.addEventListener('beforeunload', commitAndFlush);
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
