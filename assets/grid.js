/* ============================================================================
 * grid.js —— 类 Excel 的表格交互层
 *
 * 支持：
 *   · 鼠标点选 / 拖选区域
 *   · 编辑公式时用鼠标点选（或拖选区域）插入引用
 *   · **跨表引用**：编辑公式时切到别的工作表，点那边的单元格会插入 '表名'!B3
 *   · 右下角填充柄拖拽填充，相对引用自动平移（$ 锁定的不动）
 *   · 复制 / 粘贴（含从 Excel 粘贴多行多列与公式）
 *   · 方向键导航、Shift+方向键扩选、F2 编辑、Delete 清除、Ctrl+D/R 填充
 * ==========================================================================*/
(function (global) {
  'use strict';

  const FML = global.FML;

  const Grid = {};
  let ctx = null;         // 宿主提供的上下文
  let container = null;   // 外层容器
  let host = null;        // 表格容器（position:relative）
  let proxy = null;       // 非编辑态下承接键盘事件的隐藏输入框
  let handle = null;      // 填充柄
  let cells = {};         // addr -> td
  let sel = { c1: 1, r1: 2, c2: 1, r2: 2 };
  let active = { col: 1, row: 2 };
  let anchor = { col: 1, row: 2 };
  let drag = null;        // {mode:'select'|'fill'|'ref', ...}
  let clip = null;        // 内部剪贴板（保留公式与来源位置）
  let bound = false;

  /* 编辑状态。目标单元格可能不在当前显示的工作表上（跨表取数时）。 */
  let edit = null;        // { sheetIdx, sheetName, col, row, value, refIns:{start,end}|null }
  let editInput = null;   // 格内输入框；仅当 edit.sheetIdx === ctx.sheetIdx 时存在

  /* ------------------------------------------------------------------ 工具 */
  const A = (c, r) => FML.addr(c, r);
  function sheet(i) { return ctx.model.sheets[i === undefined ? ctx.sheetIdx : i]; }
  function nCols() { return sheet().header.length; }
  function nRows() { return sheet().rows.length + 1; }

  function rowOf(row, si) { return sheet(si).rows[row - 2] || null; }
  function cellDef(col, row, si) {
    const r = rowOf(row, si);
    if (!r || r.style === 'sec' || r.style === 'gap') return null;
    const c = (r.cells || [])[col - 1];
    if (!c || c.kind === 'empty') return null;
    return c;
  }
  function isInput(col, row, si) { const c = cellDef(col, row, si); return !!(c && c.kind === 'input'); }
  function rawOf(col, row, si) {
    const c = cellDef(col, row, si);
    if (!c) return '';
    if (c.kind === 'input') return ctx.inputs[sheet(si).name + '!' + A(col, row)] || '';
    if (c.kind === 'calc') return c.f;
    if (c.kind === 'given') return String(c.v);
    return '';
  }

  function norm() {
    return {
      c1: Math.min(sel.c1, sel.c2), c2: Math.max(sel.c1, sel.c2),
      r1: Math.min(sel.r1, sel.r2), r2: Math.max(sel.r1, sel.r2)
    };
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  /* ============================================================== 挂载 */
  Grid.mount = function (el, context) {
    ctx = context;
    container = el;
    edit = null; editInput = null; drag = null;
    render();
    const first = firstInput();
    setSel(first.col, first.row, first.col, first.row);
    Grid.refresh();
    return Grid;
  };

  /** 切换显示的工作表；如果正在编辑，编辑状态会被保留（用于跨表取数） */
  Grid.showSheet = function (i) {
    if (i === ctx.sheetIdx) return;
    if (edit && editInput) { edit.value = editInput.value; detachInCellInput(); }
    ctx.sheetIdx = i;
    render();
    if (edit && edit.sheetIdx === i) {
      attachInCellInput(true);
    } else {
      const first = firstInput();
      setSel(first.col, first.row, first.col, first.row);
    }
    Grid.refresh();
    if (!edit) focusProxy(); else if (!editInput) focusFx();
    notifyEdit();
  };

  function render() {
    const sh = sheet();
    container.innerHTML = '';

    const title = document.createElement('div');
    title.className = 'sheet-title';
    title.innerHTML = '<b>' + esc(sh.name) + '</b>' +
      (sh.unit ? '<span>单位：' + esc(sh.unit) + '</span>' : '') +
      (sh.note ? '<span>· ' + esc(sh.note) + '</span>' : '') +
      '<span class="gt-hint">拖右下角小方块可填充 · 写公式时可直接点选单元格，切到别的表点也行（自动加表名）</span>';
    container.appendChild(title);

    host = document.createElement('div');
    host.className = 'grid-host';
    container.appendChild(host);
    host.innerHTML = buildTable();

    handle = document.createElement('div');
    handle.className = 'fill-handle';
    handle.style.display = 'none';
    host.appendChild(handle);

    proxy = document.createElement('textarea');
    proxy.className = 'grid-proxy';
    proxy.setAttribute('autocomplete', 'off');
    proxy.setAttribute('spellcheck', 'false');
    host.appendChild(proxy);

    indexCells();
    bindOnce();
    bindLocal();
  }

  function firstInput() {
    const sh = sheet();
    for (let ri = 0; ri < sh.rows.length; ri++) {
      for (let c = 1; c < sh.header.length; c++) if (isInput(c, ri + 2)) return { col: c, row: ri + 2 };
    }
    return { col: 1, row: 2 };
  }

  function buildTable() {
    const sh = sheet();
    const n = sh.header.length;
    let h = '<table class="grid"><thead><tr><th class="rowhdr corner"></th>';
    for (let c = 0; c < n; c++) h += '<th class="colhdr">' + FML.idxToCol(c) + '</th>';
    h += '</tr><tr><th class="rowhdr">1</th>';
    for (let c = 0; c < n; c++) {
      h += '<td class="' + (c === 0 ? 'lbl' : 'cell hdrrow') + '">' +
        (c === 0 ? esc(sh.header[0]) : '<span class="disp hdrtxt">' + esc(sh.header[c]) + '</span>') + '</td>';
    }
    h += '</tr></thead><tbody>';

    sh.rows.forEach(function (r, ri) {
      const rowNum = ri + 2;
      const cls = r.style === 'sec' ? ' class="sec"' : r.style === 'tot' ? ' class="tot"' : '';
      h += '<tr' + cls + '><th class="rowhdr">' + rowNum + '</th>';
      h += '<td class="lbl">' + esc(r.label) + (r.note ? '<span class="unit">' + esc(r.note) + '</span>' : '') + '</td>';
      for (let c = 1; c < n; c++) {
        const cd = cellDef(c, rowNum);
        const a = A(c, rowNum);
        if (!cd) { h += '<td class="cell blank" data-a="' + a + '"></td>'; continue; }
        if (cd.kind === 'input') {
          h += '<td class="cell input" data-a="' + a + '"><span class="mark"></span><span class="disp"></span></td>';
        } else {
          h += '<td class="cell ' + (cd.kind === 'calc' ? 'calc' : 'given') + ' locked" data-a="' + a + '"><span class="disp"></span></td>';
        }
      }
      h += '</tr>';
    });
    return h + '</tbody></table>';
  }

  function indexCells() {
    cells = {};
    Array.prototype.forEach.call(host.querySelectorAll('td.cell[data-a]'), function (td) {
      cells[td.getAttribute('data-a')] = td;
    });
  }

  /* ============================================================== 求值显示 */
  Grid.refresh = function () {
    const sh = sheet();
    const wb = ctx.getWb(), sol = ctx.getSol();
    wb.reset(); sol.reset();
    const revealed = ctx.revealed || {};

    sh.rows.forEach(function (r, ri) {
      const rowNum = ri + 2;
      for (let c = 1; c < sh.header.length; c++) {
        const cd = cellDef(c, rowNum);
        if (!cd) continue;
        const a = A(c, rowNum);
        const td = cells[a];
        if (!td) continue;
        const disp = td.querySelector('.disp');
        const mark = td.querySelector('.mark');
        td.classList.remove('err', 'ok', 'bad');
        if (mark) mark.textContent = '';
        const fmt = cd.fmt || r.fmt;

        if (cd.kind === 'input') {
          if (edit && edit.sheetIdx === ctx.sheetIdx && edit.col === c && edit.row === rowNum) continue;
          const raw = ctx.inputs[sh.name + '!' + a] || '';
          if (!raw) { disp.textContent = ''; td.classList.add('blankval'); td.title = ''; continue; }
          td.classList.remove('blankval');
          const res = wb.tryGet(sh.name, c, rowNum);
          if (!res.ok) { disp.textContent = '#ERR'; td.classList.add('err'); td.title = res.err; continue; }
          disp.textContent = ctx.fmtVal(res.v, fmt);
          td.title = raw;
          if (ctx.showChecks()) {
            const sr = sol.tryGet(sh.name, c, rowNum);
            if (sr.ok && near(res.v, sr.v)) { td.classList.add('ok'); if (mark) mark.textContent = '✓'; }
            else { td.classList.add('bad'); if (mark) mark.textContent = '✕'; }
          } else if (revealed[sh.name + '!' + a] && mark) { mark.textContent = '·'; }
        } else {
          const res = wb.tryGet(sh.name, c, rowNum);
          if (!res.ok) { disp.textContent = '#ERR'; td.classList.add('err'); td.title = res.err; }
          else { disp.textContent = ctx.fmtVal(res.v, fmt); td.title = cd.kind === 'calc' ? cd.f : '真实数据（只读）'; }
        }
      }
    });
    paintSel();
  };

  function near(a, b) {
    if (typeof a !== 'number' || typeof b !== 'number') return false;
    if (!isFinite(a) || !isFinite(b)) return false;
    return Math.abs(a - b) <= Math.max(1e-6, Math.abs(b) * 0.002);
  }

  /* ============================================================== 选区 */
  function setSel(c1, r1, c2, r2, keepActive) {
    sel = { c1: c1, r1: r1, c2: c2, r2: r2 };
    if (!keepActive) { active = { col: c1, row: r1 }; anchor = { col: c1, row: r1 }; }
    paintSel();
    if (ctx.onSelect) ctx.onSelect(activeInfo());
  }

  function activeInfo() {
    const sh = sheet();
    const cd = cellDef(active.col, active.row);
    return {
      sheet: sh.name, sheetIdx: ctx.sheetIdx, addr: A(active.col, active.row),
      col: active.col, row: active.row,
      kind: cd ? cd.kind : 'empty',
      raw: rawOf(active.col, active.row),
      label: (rowOf(active.row) || {}).label || '',
      header: sh.header[active.col] || '',
      def: cd, range: norm()
    };
  }

  function paintSel() {
    const n = norm();
    Array.prototype.forEach.call(host.querySelectorAll('td.cell'), function (td) {
      td.classList.remove('sel', 'sel-active', 'dep', 'fillprev', 'edittarget');
    });
    for (let r = n.r1; r <= n.r2; r++) for (let c = n.c1; c <= n.c2; c++) {
      const td = cells[A(c, r)];
      if (td) td.classList.add('sel');
    }
    const at = cells[A(active.col, active.row)];
    if (at) at.classList.add('sel-active');
    if (edit && edit.sheetIdx === ctx.sheetIdx) {
      const et = cells[A(edit.col, edit.row)];
      if (et) et.classList.add('edittarget');
    }
    highlightDeps();
    placeHandle();
  }

  function highlightDeps() {
    const raw = edit ? edit.value : rawOf(active.col, active.row);
    if (!raw || raw[0] !== '=') return;
    const base = edit ? sheet(edit.sheetIdx).name : sheet().name;
    FML.refsOf(raw.slice(1), base).forEach(function (ref) {
      const p = ref.split('!');
      if (p[0] !== sheet().name) return;
      const td = cells[p[1]];
      if (td && !td.classList.contains('sel-active')) td.classList.add('dep');
    });
  }

  function placeHandle() {
    if (!handle) return;
    const n = norm();
    const td = cells[A(n.c2, n.r2)];
    if (!td || edit) { handle.style.display = 'none'; return; }
    handle.style.display = 'block';
    handle.style.left = (td.offsetLeft + td.offsetWidth - 4) + 'px';
    handle.style.top = (td.offsetTop + td.offsetHeight - 4) + 'px';
  }

  /* ============================================================== 编辑 */
  function beginEdit(col, row, initial) {
    if (!isInput(col, row)) { flash('这一格是真实数据或模型自带的计算格，不能改'); return false; }
    endEdit(true);
    edit = {
      sheetIdx: ctx.sheetIdx, sheetName: sheet().name, col: col, row: row,
      value: (initial != null) ? initial : (ctx.inputs[sheet().name + '!' + A(col, row)] || ''),
      refIns: null
    };
    attachInCellInput(initial == null);
    notifyEdit();
    return true;
  }

  function attachInCellInput(selectAll) {
    if (!edit || edit.sheetIdx !== ctx.sheetIdx) return;
    const td = cells[A(edit.col, edit.row)];
    if (!td) return;
    const disp = td.querySelector('.disp');
    if (disp) disp.style.display = 'none';
    const inp = document.createElement('input');
    inp.type = 'text';
    inp.className = 'celled';
    inp.spellcheck = false;
    inp.value = edit.value;
    td.appendChild(inp);
    td.classList.add('editing');
    editInput = inp;
    inp.focus();
    if (selectAll) inp.select(); else inp.setSelectionRange(inp.value.length, inp.value.length);
    handle.style.display = 'none';
    inp.addEventListener('keydown', onEditKey);
    inp.addEventListener('input', function () {
      edit.value = inp.value; edit.refIns = null;
      syncEditorsFrom(inp);
      paintDepsOnly();
    });
    syncEditorsFrom(inp);
    paintSel();
  }

  function detachInCellInput() {
    if (!editInput) return;
    const td = editInput.parentNode;
    if (td) {
      td.classList.remove('editing');
      const disp = td.querySelector('.disp');
      if (disp) disp.style.display = '';
      td.removeChild(editInput);
    }
    editInput = null;
  }

  function paintDepsOnly() {
    Array.prototype.forEach.call(host.querySelectorAll('td.cell.dep'), function (t) { t.classList.remove('dep'); });
    highlightDeps();
  }

  /** 把 edit.value 同步到另一个编辑器（格内 ↔ 公式栏） */
  function syncEditorsFrom(src) {
    const fx = ctx.getFx && ctx.getFx();
    if (fx && fx !== src) { fx.value = edit.value; fx.dataset.dirty = '0'; }
    if (editInput && editInput !== src) editInput.value = edit.value;
  }

  function endEdit(commit) {
    if (!edit) return;
    const e = edit;
    if (editInput) e.value = editInput.value;
    detachInCellInput();
    edit = null;
    if (commit) ctx.onChange(e.sheetName, e.col, e.row, e.value);
    Grid.refresh();
    notifyEdit();
  }

  function onEditKey(ev) { handleEditorKey(ev); }

  function handleEditorKey(ev) {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      const back = edit ? edit.sheetIdx : ctx.sheetIdx;
      endEdit(true);
      if (back !== ctx.sheetIdx) { ctx.onSheetChange(back); return; }
      move(0, 1, false); focusProxy();
    } else if (ev.key === 'Tab') {
      ev.preventDefault();
      const back = edit ? edit.sheetIdx : ctx.sheetIdx;
      endEdit(true);
      if (back !== ctx.sheetIdx) { ctx.onSheetChange(back); return; }
      move(ev.shiftKey ? -1 : 1, 0, false); focusProxy();
    } else if (ev.key === 'Escape') {
      ev.preventDefault();
      const back = edit ? edit.sheetIdx : ctx.sheetIdx;
      endEdit(false);
      if (back !== ctx.sheetIdx) ctx.onSheetChange(back);
      else focusProxy();
    }
  }

  /* 光标左侧是运算符 → 可以点选插入引用 */
  function activeEditor() { return editInput || (ctx.getFx && ctx.getFx()) || null; }

  function canInsertRef() {
    if (!edit) return false;
    const ed = activeEditor();
    if (!ed) return false;
    const v = edit.value;
    if (!v || v[0] !== '=') return false;
    if (edit.refIns) return true;
    let p = ed.selectionStart;
    if (p == null) p = v.length;
    return /[=+\-*/^(,:<>&%]\s*$/.test(v.slice(0, p));
  }

  /** 生成引用文本：跨表时自动加 '表名'! 前缀 */
  function refText(col, row, col2, row2) {
    const base = (col2 === undefined)
      ? A(col, row)
      : A(Math.min(col, col2), Math.min(row, row2)) + ':' + A(Math.max(col, col2), Math.max(row, row2));
    if (ctx.sheetIdx === edit.sheetIdx) return base;
    return "'" + sheet().name + "'!" + base;
  }

  function insertRef(txt) {
    const ed = activeEditor();
    if (!ed) return;
    const v = edit.value;
    if (!edit.refIns) {
      let p = ed.selectionStart;
      if (p == null) p = v.length;
      edit.refIns = { start: p, end: p };
    }
    edit.value = v.slice(0, edit.refIns.start) + txt + v.slice(edit.refIns.end);
    edit.refIns.end = edit.refIns.start + txt.length;
    if (editInput) editInput.value = edit.value;
    const fx = ctx.getFx && ctx.getFx();
    if (fx) { fx.value = edit.value; fx.dataset.dirty = '0'; }
    ed.focus();
    if (ed.setSelectionRange) ed.setSelectionRange(edit.refIns.end, edit.refIns.end);
    paintDepsOnly();
  }

  function notifyEdit() {
    if (!ctx.onEditState) return;
    ctx.onEditState(edit ? {
      sheetIdx: edit.sheetIdx, sheetName: edit.sheetName,
      addr: A(edit.col, edit.row), value: edit.value,
      remote: edit.sheetIdx !== ctx.sheetIdx
    } : null);
  }

  /* ============================================================== 鼠标 */
  function bindLocal() {
    host.addEventListener('mousedown', onMouseDown, true);
    host.addEventListener('mouseover', onMouseOver);
    host.addEventListener('dblclick', onDblClick);
    handle.addEventListener('mousedown', onFillDown);
    proxy.addEventListener('keydown', onProxyKey);
    proxy.addEventListener('paste', onPaste);
    proxy.addEventListener('copy', onCopy);
    proxy.addEventListener('cut', onCopy);
  }
  function bindOnce() {
    if (bound) return;
    bound = true;
    document.addEventListener('mouseup', onMouseUp);
  }

  function tdFrom(e) {
    let n = e.target;
    while (n && n !== host) {
      if (n.tagName === 'TD' && n.hasAttribute('data-a')) return n;
      n = n.parentNode;
    }
    return null;
  }
  function parse(a) {
    const m = /^([A-Z]+)([0-9]+)$/.exec(a);
    return { col: FML.colToIdx(m[1]), row: parseInt(m[2], 10) };
  }

  function onMouseDown(e) {
    if (e.button !== 0 || e.target === handle) return;
    const td = tdFrom(e);
    if (!td) return;
    const p = parse(td.getAttribute('data-a'));
    const isEditTarget = edit && edit.sheetIdx === ctx.sheetIdx && edit.col === p.col && edit.row === p.row;

    /* ① 编辑公式中点其他单元格（含其他表）→ 插入引用 */
    if (edit && !isEditTarget && canInsertRef()) {
      e.preventDefault(); e.stopPropagation();
      insertRef(refText(p.col, p.row));
      drag = { mode: 'ref', from: p };
      return;
    }
    /* ② 编辑中点了别处且不能插引用 → 先提交 */
    if (edit && !isEditTarget) {
      const back = edit.sheetIdx;
      endEdit(true);
      if (back !== ctx.sheetIdx) { /* 留在当前表 */ }
    }
    if (isEditTarget) return; /* 让输入框自己处理光标 */

    e.preventDefault();
    focusProxy();
    if (e.shiftKey) {
      setSel(anchor.col, anchor.row, p.col, p.row, true);
      active = { col: anchor.col, row: anchor.row };
      paintSel();
    } else setSel(p.col, p.row, p.col, p.row);
    drag = { mode: 'select' };
  }

  function onMouseOver(e) {
    if (!drag) return;
    const td = tdFrom(e);
    if (!td) return;
    const p = parse(td.getAttribute('data-a'));
    if (drag.mode === 'select') {
      setSel(anchor.col, anchor.row, p.col, p.row, true);
      active = { col: anchor.col, row: anchor.row };
      paintSel();
    } else if (drag.mode === 'ref') {
      const f = drag.from;
      insertRef((f.col === p.col && f.row === p.row) ? refText(f.col, f.row) : refText(f.col, f.row, p.col, p.row));
    } else if (drag.mode === 'fill') previewFill(p);
  }

  function onMouseUp() {
    if (drag && drag.mode === 'fill' && drag.target) applyFill(drag.target);
    if (drag && drag.mode === 'ref') { const ed = activeEditor(); if (ed) ed.focus(); }
    drag = null;
    if (host) Array.prototype.forEach.call(host.querySelectorAll('td.fillprev'), function (t) { t.classList.remove('fillprev'); });
  }

  function onDblClick(e) {
    const td = tdFrom(e);
    if (!td) return;
    const p = parse(td.getAttribute('data-a'));
    beginEdit(p.col, p.row);
  }

  /* ------------------------------------------------------- 填充柄 */
  function onFillDown(e) {
    e.preventDefault(); e.stopPropagation();
    if (edit) endEdit(true);
    drag = { mode: 'fill', base: norm(), target: null };
  }

  function previewFill(p) {
    const b = drag.base;
    const dRow = p.row > b.r2 ? p.row - b.r2 : (p.row < b.r1 ? p.row - b.r1 : 0);
    const dCol = p.col > b.c2 ? p.col - b.c2 : (p.col < b.c1 ? p.col - b.c1 : 0);
    const t = (Math.abs(dRow) >= Math.abs(dCol))
      ? { c1: b.c1, c2: b.c2, r1: Math.min(b.r1, p.row), r2: Math.max(b.r2, p.row) }
      : { r1: b.r1, r2: b.r2, c1: Math.min(b.c1, p.col), c2: Math.max(b.c2, p.col) };
    drag.target = t;
    Array.prototype.forEach.call(host.querySelectorAll('td.fillprev'), function (x) { x.classList.remove('fillprev'); });
    for (let r = t.r1; r <= t.r2; r++) for (let c = t.c1; c <= t.c2; c++) {
      if (r >= b.r1 && r <= b.r2 && c >= b.c1 && c <= b.c2) continue;
      const td = cells[A(c, r)];
      if (td) td.classList.add('fillprev');
    }
  }

  function applyFill(t) {
    const b = drag.base, sh = sheet();
    let n = 0, skipped = 0;
    const bw = b.c2 - b.c1 + 1, bh = b.r2 - b.r1 + 1;
    for (let r = t.r1; r <= t.r2; r++) {
      for (let c = t.c1; c <= t.c2; c++) {
        if (r >= b.r1 && r <= b.r2 && c >= b.c1 && c <= b.c2) continue;
        const sc = b.c1 + (((c - b.c1) % bw) + bw) % bw;
        const sr = b.r1 + (((r - b.r1) % bh) + bh) % bh;
        const src = rawOf(sc, sr);
        if (!isInput(c, r)) { skipped++; continue; }
        ctx.onChange(sh.name, c, r, (src && src[0] === '=') ? FML.translate(src, c - sc, r - sr) : src);
        n++;
      }
    }
    setSel(t.c1, t.r1, t.c2, t.r2);
    Grid.refresh();
    flash(skipped ? ('已填充 ' + n + ' 格，跳过 ' + skipped + ' 个只读格') : ('已填充 ' + n + ' 格，引用已自动平移'));
  }

  /* ============================================================== 键盘 */
  function focusProxy() { if (proxy && !edit) { proxy.value = ''; proxy.focus({ preventScroll: true }); } }
  function focusFx() { const fx = ctx.getFx && ctx.getFx(); if (fx) { fx.focus(); const n = fx.value.length; fx.setSelectionRange(n, n); } }
  Grid.focus = focusProxy;

  function move(dc, dr, extend) {
    let c = extend ? sel.c2 : active.col;
    let r = extend ? sel.r2 : active.row;
    const maxC = nCols() - 1, maxR = nRows();
    c = Math.max(1, Math.min(maxC, c + dc));
    r = Math.max(2, Math.min(maxR, r + dr));
    let guard = 0;
    while (guard++ < 300) {
      const rr = rowOf(r);
      if (rr && rr.style !== 'sec' && rr.style !== 'gap') break;
      const nr = r + (dr >= 0 ? 1 : -1);
      if (nr < 2 || nr > maxR) break;
      r = nr;
    }
    if (extend) { setSel(anchor.col, anchor.row, c, r, true); active = { col: anchor.col, row: anchor.row }; paintSel(); }
    else setSel(c, r, c, r);
    scrollIntoView(c, r);
  }

  function scrollIntoView(c, r) {
    const td = cells[A(c, r)];
    if (!td || !host || !host.parentNode) return;
    const wrap = host.parentNode;
    const tr = td.getBoundingClientRect(), wr = wrap.getBoundingClientRect();
    if (tr.top < wr.top + 56) wrap.scrollTop -= (wr.top + 56 - tr.top);
    if (tr.bottom > wr.bottom) wrap.scrollTop += (tr.bottom - wr.bottom + 8);
    if (tr.left < wr.left + 250) wrap.scrollLeft -= (wr.left + 250 - tr.left);
    if (tr.right > wr.right) wrap.scrollLeft += (tr.right - wr.right + 8);
  }

  function onProxyKey(e) {
    const mod = e.ctrlKey || e.metaKey;
    switch (e.key) {
      case 'ArrowUp': e.preventDefault(); move(0, -1, e.shiftKey); return;
      case 'ArrowDown': e.preventDefault(); move(0, 1, e.shiftKey); return;
      case 'ArrowLeft': e.preventDefault(); move(-1, 0, e.shiftKey); return;
      case 'ArrowRight': e.preventDefault(); move(1, 0, e.shiftKey); return;
      case 'Tab': e.preventDefault(); move(e.shiftKey ? -1 : 1, 0, false); return;
      case 'Enter': e.preventDefault();
        if (isInput(active.col, active.row)) beginEdit(active.col, active.row); else move(0, 1, false);
        return;
      case 'F2': e.preventDefault(); beginEdit(active.col, active.row); return;
      case 'Delete': case 'Backspace': {
        e.preventDefault();
        const n = norm(); let k = 0;
        for (let r = n.r1; r <= n.r2; r++) for (let c = n.c1; c <= n.c2; c++) {
          if (isInput(c, r)) { ctx.onChange(sheet().name, c, r, ''); k++; }
        }
        Grid.refresh();
        if (k) flash('已清除 ' + k + ' 格');
        return;
      }
    }
    if (mod && (e.key === 'd' || e.key === 'D')) { e.preventDefault(); fillFrom('down'); return; }
    if (mod && (e.key === 'r' || e.key === 'R')) { e.preventDefault(); fillFrom('right'); return; }
    if (mod) return;
    if (e.key.length === 1) { e.preventDefault(); beginEdit(active.col, active.row, e.key); }
  }

  function fillFrom(dir) {
    const n = norm();
    if (dir === 'down' && n.r2 <= n.r1) { flash('先选中包含源公式的一列区域'); return; }
    if (dir === 'right' && n.c2 <= n.c1) { flash('先选中包含源公式的一行区域'); return; }
    drag = { mode: 'fill', base: dir === 'down' ? { c1: n.c1, c2: n.c2, r1: n.r1, r2: n.r1 } : { c1: n.c1, c2: n.c1, r1: n.r1, r2: n.r2 } };
    applyFill(n);
    drag = null;
  }

  /* ------------------------------------------------------- 复制粘贴 */
  function onCopy(e) {
    const n = norm();
    const rows = [], raws = [];
    for (let r = n.r1; r <= n.r2; r++) {
      const line = [], rline = [];
      for (let c = n.c1; c <= n.c2; c++) {
        const raw = rawOf(c, r);
        rline.push(raw);
        const td = cells[A(c, r)];
        const disp = td ? (td.querySelector('.disp') || {}).textContent : '';
        line.push(raw && raw[0] === '=' ? raw : (disp || raw || ''));
      }
      rows.push(line.join('\t')); raws.push(rline);
    }
    const text = rows.join('\n');
    clip = { c1: n.c1, r1: n.r1, cells: raws, text: text };
    if (e.clipboardData) { e.clipboardData.setData('text/plain', text); e.preventDefault(); }
    flash('已复制 ' + (n.r2 - n.r1 + 1) + '×' + (n.c2 - n.c1 + 1) + ' 区域');
  }

  function onPaste(e) {
    e.preventDefault();
    const text = (e.clipboardData || global.clipboardData).getData('text');
    const sh = sheet();
    const internal = !!(clip && clip.text === text);
    const grid = internal ? clip.cells : text.replace(/\r/g, '').split('\n').map(function (l) { return l.split('\t'); });
    if (!grid.length) return;
    const dCol = internal ? active.col - clip.c1 : 0;
    const dRow = internal ? active.row - clip.r1 : 0;
    let n = 0, skipped = 0;
    for (let i = 0; i < grid.length; i++) {
      for (let j = 0; j < grid[i].length; j++) {
        const c = active.col + j, r = active.row + i;
        if (c >= nCols() || r > nRows()) continue;
        if (!isInput(c, r)) { skipped++; continue; }
        let v = String(grid[i][j] == null ? '' : grid[i][j]).trim();
        if (internal && v && v[0] === '=') v = FML.translate(v, dCol, dRow);
        if (v) v = v.replace(/^＝/, '=').replace(/，/g, ',');
        ctx.onChange(sh.name, c, r, v);
        n++;
      }
    }
    Grid.refresh();
    flash(skipped ? ('已粘贴 ' + n + ' 格，跳过 ' + skipped + ' 个只读格') : ('已粘贴 ' + n + ' 格'));
  }

  function flash(msg) { if (ctx.onMessage) ctx.onMessage(msg); }

  /* ============================================================== 对外 */
  Grid.active = function () { return activeInfo(); };
  Grid.isEditing = function () { return !!edit; };
  Grid.editInfo = function () {
    return edit ? { sheetIdx: edit.sheetIdx, sheetName: edit.sheetName, addr: A(edit.col, edit.row), remote: edit.sheetIdx !== ctx.sheetIdx } : null;
  };
  /** 公式栏输入时调用 */
  Grid.setEditValue = function (v) {
    if (!edit) return;
    edit.value = v; edit.refIns = null;
    if (editInput) editInput.value = v;
    paintDepsOnly();
  };
  /** 公式栏按键时调用 */
  Grid.editorKey = function (ev) { handleEditorKey(ev); };
  Grid.commitEdit = function () {
    const back = edit ? edit.sheetIdx : ctx.sheetIdx;
    endEdit(true);
    if (back !== ctx.sheetIdx) ctx.onSheetChange(back); else focusProxy();
  };
  Grid.cancelEdit = function () {
    const back = edit ? edit.sheetIdx : ctx.sheetIdx;
    endEdit(false);
    if (back !== ctx.sheetIdx) ctx.onSheetChange(back); else focusProxy();
  };
  Grid.beginEditActive = function (initial) { return beginEdit(active.col, active.row, initial); };
  Grid.setActiveValue = function (v) {
    if (!isInput(active.col, active.row)) { flash('这一格不能改'); return false; }
    ctx.onChange(sheet().name, active.col, active.row, v);
    Grid.refresh();
    return true;
  };

  global.Grid = Grid;
})(window);
