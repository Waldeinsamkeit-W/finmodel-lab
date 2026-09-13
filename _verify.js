/* ============================================================================
 * _verify.js —— 开发期自检（不进单文件打包，index.html 里也不引用）
 *
 * 在页面控制台里跑 verifyAll()，它会对每个模型做三件事：
 *   1. 用参考公式算出每一个 input / calc 格，收集报错；
 *   2. 找出标签里带「校验 / 差额 / 应为 0」的行，断言其值为 0；
 *   3. 找出算出 NaN / Infinity 的格子。
 * 用法：<script src="_verify.js"></script> 后 verifyAll() 或 verifyAll('模型id')
 *
 * 另有 verifyGrading()，查的是判定机制本身（grade.js）而不是数据，见文件末尾。
 * ==========================================================================*/
(function (global) {
  'use strict';

  /* 取值函数用引擎里的严格版本，和网页端行为一致 */
  function getter(model) { return global.FML.makeGetter(model, {}, true); }

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
    const errs = [], checks = [], nans = [], bounds = [];
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
            /* 声明了 bounds 的格子，参考答案自己必须落在界内。
               不成立说明界写错了——放着不管，学生填对反而会看到「超出范围」。 */
            if (c.bounds) {
              const lo = (c.bounds[0] === null || c.bounds[0] === undefined) ? -Infinity : c.bounds[0];
              const hi = (c.bounds[1] === null || c.bounds[1] === undefined) ? Infinity : c.bounds[1];
              if (res.v < lo || res.v > hi) {
                bounds.push({ sheet: sh.name, addr: addr, label: lbl, bounds: c.bounds, got: res.v });
              }
            }
          }
        });
      });
    });

    return { id: m.id, level: m.level, type: m.type, inputs: inputs, errs: errs, checks: checks, nans: nans, dangling: dangling, bounds: bounds };
  }

  global.verifyAll = function (only) {
    const list = global.DB.models.filter(function (m) { return !only || m.id === only; });
    const bad = [], ok = [];
    list.forEach(function (m) {
      const r = verify(m);
      if (r.errs.length || r.checks.length || r.nans.length || r.dangling.length || r.bounds.length) bad.push(r); else ok.push(r);
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

  /* ==========================================================================
   * verifyGrading() —— 判定机制自身的回归测试（grade.js）
   *
   * 对每一个作答格跑两遍，两个方向的错各查一次：
   *
   *   误伤：把参考公式原样填进去，必须判对。
   *         这个数必须是 0。判错正确答案比放过一个写死的严重得多——
   *         学生会开始不信任批改结果，整个站就废了。
   *
   *   漏网：把参考答案的数值写死填进去，必须判错。
   *         参考答案本身就是常数的格子（「填入你的假设」）不算，
   *         那种格子填常数本来就合法。
   * ========================================================================*/
  function solRefCount(sol, sheetName) {
    const s = String(sol === undefined || sol === null ? '' : sol).trim().replace(/^[=＝]/, '');
    return s ? global.FML.refsOf(s, sheetName).length : 0;
  }

  function inputCells(m) {
    const out = [];
    m.sheets.forEach(function (sh) {
      sh.rows.forEach(function (r, ri) {
        (r.cells || []).forEach(function (c, ci) {
          if (c && c.kind === 'input') {
            out.push({ sheet: sh.name, col: ci + 1, row: ri + 2, def: c, label: r.label || '' });
          }
        });
      });
    });
    return out;
  }

  /* ==========================================================================
   * verifySource() —— 数据口径与溯源盘点
   *
   * 币种 / 量级 / 财年口径是从 sheet.unit 和表头推出来的，推不出来才是问题；
   * 原文链接、页码、截止日只能人填，缺就列出来，不替它编。
   * ========================================================================*/
  global.verifySource = function () {
    const rows = global.DB.models.map(function (m) {
      const d = global.Prov.derive(m);
      return {
        id: m.id, type: m.type,
        口径: global.Prov.summary(m),
        推不出币种: !d.currencies.length,
        推不出量级: !d.scales.length,
        多币种: d.multiCurrency,
        缺: global.Prov.gaps(m)
      };
    });
    const tally = {};
    rows.forEach(function (r) { r.缺.forEach(function (g) { tally[g] = (tally[g] || 0) + 1; }); });

    /* 溯源进度。构造数据单列——它们没有原文可指，现在这样就是正确终态，
       混在一起统计会把「还差多少」夸大一倍。 */
    const st = { synthetic: [], none: [], stated: [], verified: [] };
    global.DB.models.forEach(function (m) { st[global.Prov.status(m)].push(m.id); });
    const needSource = st.none.length + st.stated.length + st.verified.length;
    const done = st.verified.length;

    return {
      溯源进度: {
        需溯源: needSource,
        已核对: done,
        已标注未核: st.stated.length,
        未标注: st.none.length,
        构造数据无需溯源: st.synthetic.length,
        完成度: needSource ? (done / needSource * 100).toFixed(1) + '%' : '—'
      },
      状态明细: st,
      models: rows.length,
      口径可推出: rows.filter(function (r) { return !r.推不出币种 && !r.推不出量级; }).length,
      推不出币种: rows.filter(function (r) { return r.推不出币种; }).map(function (r) { return r.id; }),
      推不出量级: rows.filter(function (r) { return r.推不出量级; }).map(function (r) { return r.id; }),
      多币种模型: rows.filter(function (r) { return r.多币种; }).map(function (r) { return r.id; }),
      缺口统计: tally,
      rows: rows
    };
  };

  /* ==========================================================================
   * verifyFuncs() —— 引擎函数对齐 Excel 的回归测试
   *
   * 预期值**不是引擎算出来的**，是按 Microsoft 的函数定义手工写死的。
   * verifyAll / verifyGrading 都是拿引擎测引擎，证明的是自洽不是正确；
   * 这里才是独立预期。前 9 条来自 2026-09 外部审查复现的偏差，全部曾经失败。
   * ========================================================================*/
  global.verifyFuncs = function () {
    const F = global.FML;
    /* 一张小工作簿：B2=-100, B3=121, C2=日期 0, C3=日期 730（相差两年） */
    const model = { sheets: [{ name: 'T', header: ['', 'B', 'C', 'D'], rows: [
      { label: 'r2', cells: [{ kind: 'given', v: -100 }, { kind: 'given', v: 0 },   { kind: 'given', v: 1 }] },
      { label: 'r3', cells: [{ kind: 'given', v: 121 },  { kind: 'given', v: 730 }, { kind: 'given', v: 2 }] },
      { label: 'r4', cells: [{ kind: 'given', v: 0 },    { kind: 'given', v: 0 },   { kind: 'given', v: 3 }] }
    ] }] };
    const wb = new F.Workbook(model, F.makeGetter(model, {}, true));
    const run = function (src) {
      try { return { ok: true, v: F.evaluate(F.compile(src), { sheet: 'T', get: wb.get.bind(wb) }) }; }
      catch (e) { return { ok: false, err: e.message }; }
    };
    const near = function (a, b) { return typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) <= Math.max(1e-6, Math.abs(b) * 1e-6); };

    /* [公式, 预期]  预期为 'ERR' 表示应报错 */
    const CASES = [
      /* ---- 外部审查的 9 条 ---- */
      ['XIRR(B2:B3,C2:C3)',        0.10],           // 两年 -100→121 = 10%/年
      ['PV(10%,1,0,110)',          -100],
      ['PMT(10%,1,100,0,1)',       -100],
      ['FV(10%,1,-100,0,1)',       110],
      ['ROUND(-1.5,0)',            -2],
      ['IFERROR(SQRT(-1),99)',     99],
      ['IF("a"="b",1,0)',          0],
      ['IRR(B4:B4)',               'ERR'],          // 全零
      ['SUMPRODUCT(B2:B3,D2:D4)',  'ERR'],          // 2 对 3
      /* ---- 同类边界，防止只修点不修面 ---- */
      ['ROUND(2.5,0)',             3],
      ['ROUND(-2.5,0)',            -3],
      ['ROUND(1.005,2)',           1.01],           // 二进制误差
      ['IF("a"="A",1,0)',          1],              // 不区分大小写
      ['IF("b">"a",1,0)',          1],
      ['IF(1<"a",1,0)',            1],              // 数 < 文本
      ['IFERROR(1/0,7)',           7],
      ['IFERROR(LN(0),5)',         5],
      ['PMT(0,10,1000)',           -100],           // 零利率
      ['PV(0,10,-100)',            1000],
      ['FV(0,10,-100)',            1000],
      ['PMT(10%,1,100)',           -110],           // 期末付默认
      ['SUMPRODUCT(B2:B3,B2:B3)',  24641],          // 100² + 121²
      ['IRR(B2:B3)',               0.21],           // 一期 -100→121
      ['AVG(D2:D4)',               2],              // 别名仍可算
      ['SQRT(-1)',                 'ERR'],          // 不包 IFERROR 时直接报错
    ];

    const fails = [];
    CASES.forEach(function (c) {
      const r = run(c[0]);
      if (c[1] === 'ERR') { if (r.ok) fails.push({ f: c[0], want: '报错', got: r.v }); return; }
      if (!r.ok) { fails.push({ f: c[0], want: c[1], got: '报错: ' + r.err }); return; }
      if (!near(r.v, c[1])) fails.push({ f: c[0], want: c[1], got: r.v });
    });

    /* 导出分类：和 Workbook.get 的判定必须一致 */
    const CLS = [
      ['＝B3-B6',       'formula'], ['100+23', 'formula'], ['=SUM（D3，-D6）', 'formula'],
      ['1,234',         'number'],  ['15%',    'number'],  ['-3.5e2',          'number'],
      ['',              'empty'],   ['B3',     'formula']
    ];
    CLS.forEach(function (c) {
      const k = F.classifyInput(c[0]).kind;
      if (k !== c[1]) fails.push({ f: 'classify(' + c[0] + ')', want: c[1], got: k });
    });
    const canon = F.canonicalFormula('SUM（D3，-D6）+AVG(B2:B3)');
    if (canon !== 'SUM(D3,-D6)+AVERAGE(B2:B3)') fails.push({ f: 'canonicalFormula', want: 'SUM(D3,-D6)+AVERAGE(B2:B3)', got: canon });

    /* 区域上限：refsOf 不应展开超限区域 */
    const big = F.refsOf('SUM(A1:Z500)', 'T');
    if (big.length > 2) fails.push({ f: 'refsOf(A1:Z500)', want: '≤2（不展开）', got: big.length });

    return { total: CASES.length + CLS.length + 2, failed: fails.length, fails: fails };
  };

  global.verifyGrading = function (only) {
    const FMLg = global.FML, G = global.Grade;
    const list = global.DB.models.filter(function (m) { return !only || m.id === only; });
    const missed = [], harmed = [], blind = [];
    let cells = 0, exempt = 0;

    list.forEach(function (m) {
      const solWb = new FMLg.Workbook(m, FMLg.makeGetter(m, {}, true));
      const keys = inputCells(m);
      const inputs = {};
      keys.forEach(function (k) { inputs[k.sheet + '!' + FMLg.addr(k.col, k.row)] = String(k.def.sol); });

      /* --- 方向一：全填参考公式，应当全对 --- */
      const g = G.build(m, inputs);
      keys.forEach(function (k) {
        cells++;
        const v = g.of(k.sheet, k.col, k.row);
        if (!v.ok) {
          harmed.push({
            id: m.id, sheet: k.sheet, addr: FMLg.addr(k.col, k.row),
            label: k.label, code: v.code, sol: k.def.sol, err: v.err
          });
        }
      });

      /* --- 原理盲区：参考答案本身就是与数据无关的常数 --- */
      keys.forEach(function (k) {
        if (g.invariant(k.sheet, k.col, k.row)) {
          blind.push({ id: m.id, sheet: k.sheet, addr: FMLg.addr(k.col, k.row), label: k.label, sol: k.def.sol });
        }
      });

      /* --- 方向二：逐格写死正确答案，应当全错 --- */
      keys.forEach(function (k) {
        if (solRefCount(k.def.sol, k.sheet) === 0) { exempt++; return; }
        const key = k.sheet + '!' + FMLg.addr(k.col, k.row);
        const r = solWb.tryGet(k.sheet, k.col, k.row);
        if (!r.ok || typeof r.v !== 'number' || !isFinite(r.v)) return;
        const saved = inputs[key];
        inputs[key] = String(r.v);
        g.reset();
        const v = g.of(k.sheet, k.col, k.row);
        if (v.ok) {
          missed.push({
            id: m.id, sheet: k.sheet, addr: FMLg.addr(k.col, k.row),
            label: k.label, sol: k.def.sol, hardcoded: r.v
          });
        }
        inputs[key] = saved;
      });
      g.reset();
    });

    return {
      models: list.length, cells: cells,
      误伤: harmed.length,          // 必须为 0
      漏网: missed.length,          // 必须为 0
      常数格豁免: exempt,           // 参考答案本身就是常数，填常数合法
      原理盲区: blind.length,       // 答案与数据无关，只受结构检查保护，见 Grade.invariant
      harmed: harmed, missed: missed, blind: blind
    };
  };
})(window);
