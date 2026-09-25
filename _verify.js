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
    const P = global.Prov;
    const rows = global.DB.models.map(function (m) {
      const d = P.derive(m);
      return {
        id: m.id, type: m.type,
        数据类型: P.kind(m),
        溯源状态: P.status(m),
        口径: P.summary(m),
        推不出币种: !d.currencies.length,
        推不出量级: !d.scales.length,
        多币种: d.multiCurrency,
        给定格: P.fieldTally(m),
        分类待复核: P.noteMismatch(m),
        缺: P.gaps(m)
      };
    });
    const tally = {};
    rows.forEach(function (r) {
      r.缺.forEach(function (g) {
        const key = g.indexOf('尚未核对的部分') === 0 ? '尚未核对的部分（见 rows[].缺）' : g;
        tally[key] = (tally[key] || 0) + 1;
      });
    });

    /* 溯源进度。构造数据单列——它们没有原文可指，现在这样就是正确终态，
       混在一起统计会把「还差多少」夸大一倍。
       「部分核对」单列：核了一部分数的模型不能算进「已核对」，否则完成度就是装饰。 */
    const st = { synthetic: [], none: [], stated: [], partial: [], verified: [] };
    rows.forEach(function (r) { st[r.溯源状态].push(r.id); });
    const needSource = rows.length - st.synthetic.length;
    const done = st.verified.length;

    /* 字段级盘点：全站给定格按「原始披露 / 换算或近似 / 预测假设 / 教学假设」分几类，
       分类来自格子与行的标注（Prov.fieldKind），不是来自整段说明文字。 */
    const fields = { disclosed: 0, derived: 0, forecast: 0, assumption: 0, unverified: 0, total: 0 };
    rows.forEach(function (r) { Object.keys(fields).forEach(function (k) { fields[k] += r.给定格[k]; }); });

    return {
      溯源进度: {
        需溯源: needSource,
        数值已核对: done,
        部分核对: st.partial.length,
        已标注未核: st.stated.length,
        未标注: st.none.length,
        构造数据无需溯源: st.synthetic.length,
        完成度: needSource ? (done / needSource * 100).toFixed(1) + '%' : '—'
      },
      数据类型: {
        构造: rows.filter(function (r) { return r.数据类型 === 'synthetic'; }).length,
        真实加假设: rows.filter(function (r) { return r.数据类型 === 'mixed'; }).length,
        只有真实数据: rows.filter(function (r) { return r.数据类型 === 'real'; }).length
      },
      给定格分类: {
        原始披露: fields.disclosed, 换算或近似: fields.derived,
        预测假设: fields.forecast, 教学假设: fields.assumption,
        标了待核: fields.unverified, 合计: fields.total
      },
      /* 说明文字和 dataKind 声明对不上的模型：只报出来给人看，不自动改分类 */
      分类待复核: rows.filter(function (r) { return r.分类待复核; }).map(function (r) { return r.id + '：' + r.分类待复核; }),
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

  /* ==========================================================================
   * verifyScenarios() —— 边界情景与独立基准值
   *
   * verifyAll 只在默认输入下跑一次：默认情景对得上，不代表公式对。
   * 2026-09 外部核验抓到的几处经济逻辑错误——清算瀑布转股后分错了分母、
   * 参与分配在低退出价下发出比退出价还多的钱、业绩补偿上限没进公式、
   * 协同门槛用永续近似——在默认输入下全都「配平」。
   *
   * 这里把某些给定格钉成边界值（退出价 0 / 4,000、亏损 40,000……），
   * 再和**手算的预期值**比。预期值不是引擎算的，改公式之前先在这里加用例。
   * ========================================================================*/
  global.verifyScenarios = function () {
    const F = global.FML;
    function model(id) { return global.DB.models.filter(function (m) { return m.id === id; })[0]; }
    function val(id, override, ref) {
      const m = model(id);
      if (!m) return { ok: false, err: '找不到模型 ' + id };
      const wb = new F.Workbook(m, F.makeGetter(m, {}, true, { override: override || {} }));
      const i = ref.lastIndexOf('!');
      const mm = /^([A-Z]{1,2})(\d+)$/.exec(ref.slice(i + 1));
      return wb.tryGet(ref.slice(0, i), F.colToIdx(mm[1]), parseInt(mm[2], 10));
    }
    const WF = 'Cap Table 与条款', NP = '不参与分配瀑布', PA = '参与分配与情景';
    const EO = '业绩承诺与补偿', SY = '协同效应量化', BID = '最高可出价';
    const exit = function (v) { const o = {}; o[WF + '!B22'] = v; return o; };

    /* [模型, 情景说明, override, 检查格, 手算预期] */
    const CASES = [
      /* ---- vc-waterfall：不参与分配（AUD-03）。B 轮保留优先权时，A 轮转股只能和创始人按 25:55 分剩余 ---- */
      ['vc-waterfall', '退出 15,000：A 轮', null, NP + '!B16', 3125],
      ['vc-waterfall', '退出 15,000：创始人', null, NP + '!B20', 6875],
      ['vc-waterfall', 'A 轮转股临界点 = 5,000 + 3,000 ÷ (25/80)', null, WF + '!B19', 14600],
      ['vc-waterfall', 'B 轮转股临界点 = 5,000 ÷ 20%', null, WF + '!C19', 25000],
      ['vc-waterfall', '退出 20,000：A 轮', exit(20000), NP + '!B16', 4687.5],
      ['vc-waterfall', '退出 20,000：创始人', exit(20000), NP + '!B20', 10312.5],
      ['vc-waterfall', '退出 30,000：B 轮全体转股', exit(30000), NP + '!B9', 6000],
      ['vc-waterfall', '退出 30,000：创始人', exit(30000), NP + '!B20', 16500],
      ['vc-waterfall', '退出 4,000：B 轮拿走全部', exit(4000), NP + '!B9', 4000],
      ['vc-waterfall', '退出 4,000：创始人', exit(4000), NP + '!B20', 0],
      ['vc-waterfall', '退出 0：分配合计', exit(0), NP + '!B23', 0],
      /* ---- vc-waterfall：参与分配（AUD-04）。优先额按顺位封顶，三方合计不能超过退出价 ---- */
      ['vc-waterfall', '参与分配 · 退出 4,000：三方合计', exit(4000), PA + '!B19', 4000],
      ['vc-waterfall', '参与分配 · 退出 4,000：A 轮', exit(4000), PA + '!B17', 0],
      ['vc-waterfall', '参与分配 · 退出 8,000：创始人', exit(8000), PA + '!B18', 0],
      ['vc-waterfall', '参与分配 · 退出 15,000：B 轮', null, PA + '!B16', 6400],
      ['vc-waterfall', '参与分配 · 退出 15,000：创始人', null, PA + '!B18', 3850],
      /* ---- earnout-vam（AUD-05）。上限必须进应补偿公式 ---- */
      ['earnout-vam', '默认：第 1 年补偿', null, EO + '!B20', 10000 / 3],
      ['earnout-vam', '默认：累计补偿', null, EO + '!D22', 5000],
      ['earnout-vam', '第 1 年亏损 40,000：当年补偿封顶', { '业绩承诺与补偿!B7': -40000 }, EO + '!B20', 100000],
      ['earnout-vam', '第 1 年亏损 40,000：累计补偿不超过作价', { '业绩承诺与补偿!B7': -40000 }, EO + '!D22', 100000],
      ['earnout-vam', '三年零利润：累计补偿正好等于作价', { '业绩承诺与补偿!B7': 0, '业绩承诺与补偿!C7': 0, '业绩承诺与补偿!D7': 0 }, EO + '!D22', 100000],
      /* ---- ma-synergy（AUD-07）。门槛用同一现金流模型反解，整合成本不按比例缩放 ---- */
      ['ma-synergy', '每 1 万元年化税前协同的现值', null, SY + '!B36', 0.75 * (0.3 / 1.1 + 0.7 / 1.21 + 1 / 1.331 + 1.02 / 0.08 / 1.331)],
      ['ma-synergy', '整合成本现值（税后）', null, SY + '!B35', 4500 * (0.6 / 1.1 + 0.4 / 1.21)],
      ['ma-synergy', '盈亏平衡年化税前协同', null, BID + '!B19', 7624.538063562457],
      ['ma-synergy', '按门槛协同重算，协同现值正好等于 6 亿溢价', { '协同效应量化!B9': 7624.538063562457 }, SY + '!B31', 60000],
      ['ma-synergy', '只剩成本协同时的协同现值', null, BID + '!B26', 56439.66942148758],
      /* ---- 原始数据更正后的关键结果（USHK-01/02/04/08、AUD-01） ---- */
      ['tcent-sotp-full', '分部毛利加总 = 合并毛利 349,246', null, '双口径分部估值!D16', 349246],
      ['tcent-sotp-full', '2024 整体毛利率', null, '双口径分部估值!D19', 349246 / 660257],
      ['aapl-cf-derive', '资产负债表差额与现金流量表列示值之差', null, '倒推现金流量表!B24', -306],
      ['aapl-cf-derive', '经营活动现金流', null, '倒推现金流量表!B26', 118254],
      ['aapl-income', '净利润变动桥：其他收支', null, '利润表分析!D42', 834],
      ['aapl-income', '净利润变动桥：三项合计', null, '利润表分析!D44', -3259],
      ['cssc-swap', '预案价格比与公告比例之差只是舍入', null, '换股与股本!B7', 0.1335 / (5.05 / 37.84) - 1],
      ['cssc-swap', '版本混用造出的假溢价', null, '换股与股本!B36', 0.1339 / (5.05 / 37.84) - 1]
    ];

    const fails = [];
    CASES.forEach(function (c) {
      const r = val(c[0], c[2], c[3]);
      if (!r.ok) { fails.push({ id: c[0], case: c[1], cell: c[3], want: c[4], got: '报错: ' + r.err }); return; }
      if (typeof r.v !== 'number' || Math.abs(r.v - c[4]) > Math.max(1e-6, Math.abs(c[4]) * 1e-9)) {
        fails.push({ id: c[0], case: c[1], cell: c[3], want: c[4], got: r.v });
      }
    });
    return { total: CASES.length, failed: fails.length, fails: fails };
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
