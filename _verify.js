/* ============================================================================
 * _verify.js —— 开发期自检（不进单文件打包，index.html 里也不引用）
 *
 * 在页面控制台里跑 verifyAll()，它会对每个模型做三件事：
 *   1. 用参考公式算出每一个 input / calc 格，收集报错；
 *   2. 找出标签里带「校验 / 差额 / 应为 0」的行，断言其值为 0；
 *   3. 找出算出 NaN / Infinity 的格子。
 * 用法：<script src="_verify.js"></script> 后 verifyAll() 或 verifyAll('模型id')
 * ==========================================================================*/
(function (global) {
  'use strict';

  function getter(model) {
    const map = {};
    model.sheets.forEach(function (s) { map[s.name] = s; });
    return function (sheetName, col, row) {
      const sh = map[sheetName];
      if (!sh) return { kind: 'number', raw: 0 };
      if (row === 1) return { kind: 'text', raw: sh.header[col] || '' };
      const r = sh.rows[row - 2];
      if (!r) return { kind: 'number', raw: 0 };
      if (col === 0) return { kind: 'text', raw: r.label || '' };
      const c = (r.cells || [])[col - 1];
      if (!c) return { kind: 'number', raw: 0 };
      if (c.kind === 'given') return { kind: 'number', raw: c.v };
      if (c.kind === 'calc') return { kind: 'formula', raw: c.f };
      if (c.kind === 'text') return { kind: 'text', raw: c.t };
      if (c.kind === 'input') return { kind: 'formula', raw: c.sol };
      return { kind: 'number', raw: 0 };
    };
  }

  /* 只认「明确说了该等于多少」的行。光有「校验」两字不算——很多校验行是
     「合计应等于另一行」，值本身不是 0。 */
  const ZERO_RE = /应(为|接近)\s*0|必须(是|为)\s*0|配平差/;
  const ONE_RE = /应为\s*100\s*%/;
  /* 年报原文本身就是四舍五入到两位小数的，勾稽残差到 0.05 都算对上了 */
  const TOL = 0.05;

  /* 指向空格 / 越界格的引用。这类公式语法完全合法、也算得出数，只是把 0 当成了
     真实数据——上面那些检查一个都抓不到，只能靠结构比对。区域引用（B3:D3）跳过，
     因为区域里本来就允许有空格。 */
  const REF_RE = /(?:'([^']+)'!|([A-Za-z_一-龥][\w.一-龥]*)!)?\$?([A-Za-z]{1,2})\$?(\d{1,5})(\s*:\s*\$?[A-Za-z]{1,2}\$?\d{1,5})?/g;

  function colToIdx(s) {
    let n = 0; const up = s.toUpperCase();
    for (let i = 0; i < up.length; i++) n = n * 26 + (up.charCodeAt(i) - 64);
    return n - 1;
  }

  function danglingRefs(m, sheet, addr, label, f) {
    if (!f) return [];
    const map = {};
    m.sheets.forEach(function (s) { map[s.name] = s; });
    const out = [];
    let mt;
    REF_RE.lastIndex = 0;
    while ((mt = REF_RE.exec(String(f))) !== null) {
      if (mt[5]) continue;                                  // 区域引用，跳过
      const shName = mt[1] || mt[2] || sheet;
      const sh = map[shName];
      if (!sh) { out.push({ sheet: sheet, addr: addr, label: label, f: f, ref: mt[0], why: '表名不存在' }); continue; }
      const col = colToIdx(mt[3]), row = parseInt(mt[4], 10);
      if (row === 1) continue;                              // 表头行
      const r = sh.rows[row - 2];
      if (!r) { out.push({ sheet: sheet, addr: addr, label: label, f: f, ref: mt[0], why: '行越界' }); continue; }
      const c = (r.cells || [])[col - 1];
      if (!c || c.kind === 'empty') {
        out.push({ sheet: sheet, addr: addr, label: label, f: f, ref: mt[0], why: '指向空格：' + (r.label || '(无标签)') });
      }
    }
    return out;
  }

  function verify(m) {
    const wb = new global.FML.Workbook(m, getter(m));
    const errs = [], checks = [], nans = [];
    let dangling = [];
    let inputs = 0;

    m.sheets.forEach(function (sh) {
      sh.rows.forEach(function (r, ri) {
        const row = ri + 2;
        (r.cells || []).forEach(function (c, ci) {
          if (!c || c.kind === 'empty' || c.kind === 'text' || c.kind === 'given') return;
          const col = ci + 1;
          const addr = global.FML.addr(col, row);
          if (c.kind === 'input') inputs++;
          dangling = dangling.concat(danglingRefs(m, sh.name, addr, r.label, c.sol || c.f));
          const res = wb.tryGet(sh.name, col, row);
          if (!res.ok) {
            errs.push({ sheet: sh.name, addr: addr, label: r.label, f: c.sol || c.f, err: res.err });
            return;
          }
          if (typeof res.v === 'number' && !isFinite(res.v)) {
            nans.push({ sheet: sh.name, addr: addr, label: r.label, f: c.sol || c.f, v: String(res.v) });
          }
          const lbl = r.label || '';
          if (typeof res.v === 'number') {
            const want = ONE_RE.test(lbl) ? 1 : (ZERO_RE.test(lbl) ? 0 : null);
            if (want !== null && Math.abs(res.v - want) > TOL) {
              checks.push({ sheet: sh.name, addr: addr, label: lbl, want: want, got: res.v });
            }
          }
        });
      });
    });

    return { id: m.id, level: m.level, type: m.type, inputs: inputs, errs: errs, checks: checks, nans: nans, dangling: dangling };
  }

  global.verifyAll = function (only) {
    const list = global.DB.models.filter(function (m) { return !only || m.id === only; });
    const bad = [], ok = [];
    list.forEach(function (m) {
      const r = verify(m);
      if (r.errs.length || r.checks.length || r.nans.length || r.dangling.length) bad.push(r); else ok.push(r);
    });
    return {
      total: list.length,
      passed: ok.length,
      failed: bad.length,
      cells: ok.concat(bad).reduce(function (s, r) { return s + r.inputs; }, 0),
      failures: bad
    };
  };

  global.verifyOne = function (id) { return verify(global.DB.models.filter(function (m) { return m.id === id; })[0]); };
})(window);
