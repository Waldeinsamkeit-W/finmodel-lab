/* ============================================================================
 * grade.js —— 作答判定
 *
 * 旧版只比最终数值，于是「不写公式、直接把正确答案敲进去」也算对。
 * 那让整个站的前提失效了：学生练的是建模，不是抄数。
 *
 * 判定分三步，任何一步不过就是错：
 *
 *   1. 值      —— 和参考答案一致（容差见下）
 *   2. 结构    —— 参考答案是从别的格子推出来的，你就不能填常数
 *   3. 扰动    —— 把上游真实数据换成一组「平行世界」的数据整表重算，
 *                 等价的写法在每个世界里都跟参考答案一致
 *
 * 第 3 步是关键。它同时解决三件事，且不需要逐格标注：
 *
 *   写死正确答案        → 平行世界里纹丝不动，参考答案却动了      → ✕
 *   错公式碰巧同值      → 动了，但和参考答案的动法对不上          → ✕
 *   写法不同但等价      → 在每个世界里都和参考答案一致            → ✓
 *
 * 最后一行是这个方案相对「比对引用集合」的全部价值：毛利可以写
 * =收入-成本，也可以写 =收入*(1-成本率)，引用的格子完全不同，两个都对。
 * 按引用集合判会把后者判错——误伤正确答案比放过一个写死的伤害大得多。
 *
 * 「填入你的假设」这类格子会自动豁免：参考答案自己就是常数，
 * 第 2 步就放行了，不需要任何标注。
 * ==========================================================================*/
(function (global) {
  'use strict';

  const FML = global.FML;
  const Grade = {};

  /* --------------------------------------------------------------- 容差 */
  /* 相对容差 1e-6。等价公式之间的浮点误差在 1e-15 量级，1e-6 已经很宽松。
     旧版全站统一的 0.2% 是留给「手算中间值、四舍五入后填进去」的人的——
     而那正是这次要禁掉的行为，所以跟着判定一起收紧。
     源数据本身带舍入残差的格子，用 I(sol, {tol: 0.002}) 单独放宽。

     绝对下限保持 1e-6：校验行的参考答案是 0，相对容差在那里退化成 0，
     必须靠下限兜住浮点噪声。这个值是旧版一直在用的，56 个模型上验证过。 */
  Grade.TOL = 1e-6;
  const ABS_FLOOR = 1e-6;

  function isNum(x) { return typeof x === 'number' && isFinite(x); }

  function near(a, b, tol) {
    if (!isNum(a) || !isNum(b)) return a === b;
    const t = (tol === undefined || tol === null) ? Grade.TOL : tol;
    return Math.abs(a - b) <= Math.max(ABS_FLOOR, Math.abs(b) * t);
  }
  Grade.near = near;

  /* --------------------------------------------------------------- 扰动 */
  const SEEDS = ['p1', 'p2'];

  function hash32(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }

  /* 每个 given 格乘一个 1.03~1.15 之间、由「表名+地址+种子」决定的固定因子。
     几个约束都是有原因的：
       · 保号、幅度小 —— 不会把永续增长率扰到超过折现率，也不会把分母扰成 0；
       · 逐格不同     —— 整表等比缩放会让一大批比率类公式纹丝不动，那样
                         写死的格子和正确的格子表现一样，就抓不出来了；
       · 由地址定值   —— 同一格每次扰动结果相同，判定可复现，不会时对时错。 */
  function mkPerturb(seed) {
    return function (sheetName, col, row, v) {
      if (!isNum(v) || v === 0) return v;
      const h = hash32(sheetName + '|' + col + '|' + row + '|' + seed);
      return v * (1.03 + (h % 1201) / 1201 * 0.12);
    };
  }

  /* 公式里引用到的格子。sol 可能不带等号（_schema.js 允许），统一剥掉再看。 */
  function refsOf(raw, sheetName) {
    const s = String(raw === undefined || raw === null ? '' : raw).trim().replace(/^[=＝]/, '');
    return s ? FML.refsOf(s, sheetName) : [];
  }

  /* 'sheet!B12' -> {sheet, col, row} */
  function splitRef(ref) {
    const i = ref.lastIndexOf('!');
    if (i < 0) return null;
    const m = /^([A-Za-z]{1,2})(\d{1,5})$/.exec(ref.slice(i + 1));
    return m ? { sheet: ref.slice(0, i), col: FML.colToIdx(m[1]), row: parseInt(m[2], 10) } : null;
  }

  /* ------------------------------------------------------------- 判定器 */
  /**
   * @param model  模型定义
   * @param inputs 用户输入表（按引用持有；改完调 reset()）
   * @returns { of(sheet,col,row), reset(), scan() }
   */
  Grade.build = function (model, inputs) {
    inputs = inputs || {};
    const sheetByName = Object.create(null);
    (model.sheets || []).forEach(function (s) { sheetByName[s.name] = s; });

    let wbU, wbS, solP, iso, memo;

    function fresh() {
      wbU = new FML.Workbook(model, FML.makeGetter(model, inputs, false));
      wbS = new FML.Workbook(model, FML.makeGetter(model, {}, true));
      solP = Object.create(null);
      SEEDS.forEach(function (sd) {
        solP[sd] = new FML.Workbook(model, FML.makeGetter(model, {}, true, { perturb: mkPerturb(sd) }));
      });
      iso = Object.create(null);
      memo = Object.create(null);
    }
    fresh();

    /* 隔离工作簿：只有 key 这一格取用户输入，其余 input 格一律取参考公式。
       否则上游填错会把下游每一格都判成不等价——那一格的公式明明是对的。 */
    function isoWb(key, seed) {
      const k = key + '@' + (seed || '-');
      if (!iso[k]) {
        iso[k] = new FML.Workbook(model, FML.makeGetter(model, inputs, false, {
          userOnly: key, perturb: seed ? mkPerturb(seed) : null
        }));
      }
      return iso[k];
    }

    function defOf(sheetName, col, row) {
      const sh = sheetByName[sheetName];
      if (!sh) return null;
      const r = (sh.rows || [])[row - 2];
      if (!r) return null;
      return (r.cells || [])[col - 1] || null;
    }

    /* 逐个把公式引用到的格子钉成别的值，看这一格动不动。
       只戳公式自己引用的格子，所以换一种合法写法不会被误判——
       =收入-成本 和 =收入*(1-成本率) 各自对各自引用的格子敏感，两个都过。 */
    function probeSensitive(mkWb, baseWb, refs, sheetName, col, row, tol) {
      if (!refs.length) return false;
      const base = baseWb.tryGet(sheetName, col, row);
      if (!base.ok || !isNum(base.v)) return true;      // 测不了就别误伤

      const seen = Object.create(null);
      let probed = 0;
      for (let i = 0; i < refs.length && probed < 6; i++) {
        if (seen[refs[i]]) continue;
        seen[refs[i]] = true;
        const p = splitRef(refs[i]);
        if (!p) continue;
        const cur = baseWb.tryGet(p.sheet, p.col, p.row);
        if (!cur.ok || !isNum(cur.v)) continue;
        const ov = Object.create(null);
        ov[refs[i]] = cur.v * 1.07 + 1;                 // +1 是为了 0 也能被戳动
        const t = mkWb(ov).tryGet(sheetName, col, row);
        probed++;
        if (!t.ok) return true;                          // 依赖到报错，显然敏感
        if (!near(t.v, base.v, tol)) return true;
      }
      return probed > 0 ? false : true;
    }

    /* 回退判定：用户公式对自己引用的格子完全不敏感，而参考答案是敏感的
       —— 那就是 =0*C18+0 这种假引用。
       两边都不敏感（=B3/$B$3*100 恒等于 100、IF 出来的布尔标记）说明这一格
       本来就测不出敏感性，只能放过，不能算错。 */
    function fakeRef(key, sheetName, col, row, raw, def, tol) {
      const userSens = probeSensitive(
        function (ov) {
          return new FML.Workbook(model, FML.makeGetter(model, inputs, false, { userOnly: key, override: ov }));
        },
        isoWb(key, null), refsOf(raw, sheetName), sheetName, col, row, tol);
      if (userSens) return false;

      const solSens = probeSensitive(
        function (ov) {
          return new FML.Workbook(model, FML.makeGetter(model, {}, true, { override: ov }));
        },
        wbS, refsOf(def.sol, sheetName), sheetName, col, row, tol);
      return solSens;
    }

    function equiv(sheetName, col, row, key, raw, def, tol) {
      /* 第 2 步：结构。
         参考答案是推出来的 → 你也得推；参考答案本身是常数 → 填常数合法。
         这一道就挡住了 114728 和 =114728，且零误判。 */
      const solRefs = refsOf(def.sol, sheetName).length;
      if (solRefs === 0) return { ok: true };
      if (refsOf(raw, sheetName).length === 0) return { ok: false, code: 'const' };

      /* 第 3 步：扰动。 */
      const base = isoWb(key, null).tryGet(sheetName, col, row);
      const baseOk = base.ok && isNum(base.v);
      let tested = 0, refMoved = false, userMoved = false, miss = null;

      for (let i = 0; i < SEEDS.length; i++) {
        const sd = SEEDS[i];
        const sp = solP[sd].tryGet(sheetName, col, row);
        /* 扰动把参考答案自己算炸了（除零之类），这一轮不作数 */
        if (!sp.ok || !isNum(sp.v)) continue;
        const up = isoWb(key, sd).tryGet(sheetName, col, row);
        /* 换一组数据你的公式就报错，说明它依赖了这组数据的巧合 */
        if (!up.ok) return { ok: false, code: 'nonequiv', refVal: sp.v, yourVal: null, err: up.err };
        tested++;
        if (baseOk && !near(sp.v, base.v, tol)) refMoved = true;
        if (baseOk && isNum(up.v) && !near(up.v, base.v, tol)) userMoved = true;
        if (!near(up.v, sp.v, tol) && !miss) miss = { refVal: sp.v, yourVal: up.v };
      }

      /* 参考答案对 given 的扰动免疫——典型是恒等式校验行（资产-负债-权益
         在任何一组数据下都是 0）。这时「动没动」这个信号失效，改用回退探测。 */
      if (!tested || !refMoved) {
        return fakeRef(key, sheetName, col, row, raw, def, tol) ? { ok: false, code: 'const' } : { ok: true };
      }
      if (!miss) return { ok: true };
      if (!userMoved) return { ok: false, code: 'const', refVal: miss.refVal, yourVal: miss.yourVal };
      return { ok: false, code: 'nonequiv', refVal: miss.refVal, yourVal: miss.yourVal };
    }

    function compute(sheetName, col, row, key) {
      const def = defOf(sheetName, col, row);
      if (!def || def.kind !== 'input') return { ok: false, code: 'notinput' };
      const raw = inputs[key] || '';
      if (!raw) return { ok: false, code: 'blank' };

      const tol = (def.tol === undefined || def.tol === null) ? Grade.TOL : def.tol;
      const u = wbU.tryGet(sheetName, col, row);
      const s = wbS.tryGet(sheetName, col, row);

      if (!u.ok) return { ok: false, code: 'err', err: u.err, solVal: s.ok ? s.v : null };
      if (!s.ok) return { ok: false, code: 'solerr', err: s.err, userVal: u.v };
      if (!near(u.v, s.v, tol)) return { ok: false, code: 'value', userVal: u.v, solVal: s.v };

      const eq = equiv(sheetName, col, row, key, raw, def, tol);
      if (eq.ok) return { ok: true, code: 'ok', userVal: u.v, solVal: s.v };
      return {
        ok: false, code: eq.code, userVal: u.v, solVal: s.v,
        refVal: eq.refVal, yourVal: eq.yourVal, err: eq.err
      };
    }

    const g = {};

    g.of = function (sheetName, col, row) {
      const key = sheetName + '!' + FML.addr(col, row);
      if (key in memo) return memo[key];
      let v;
      try { v = compute(sheetName, col, row, key); }
      catch (e) { v = { ok: false, code: 'err', err: e.message }; }
      memo[key] = v;
      return v;
    };

    /* 输入变了就调它。工作簿按引用持有 inputs，重建只是清缓存，求值仍是惰性的。 */
    g.reset = function () { fresh(); };

    /* 这一格的参考答案是不是「与数据无关的常数」。
       百分比合计恒为 1、指数基期恒为 100、IF 出来的布尔标记、恒等式校验行恒为 0
       ——这类格子的正确公式本身就是常数函数，行为上和一个伪装成公式的常数
       （=0*B3+1）完全不可区分。它们只受结构检查保护：直接敲 1 会被判错，
       但刻意写成 =0*B3+1 抓不出来。
       这是方法的原理边界，不是实现缺陷。verifyGrading() 会统计它的规模。 */
    g.invariant = function (sheetName, col, row) {
      const def = defOf(sheetName, col, row);
      if (!def || def.kind !== 'input') return false;
      const tol = (def.tol === undefined || def.tol === null) ? Grade.TOL : def.tol;
      const b = wbS.tryGet(sheetName, col, row);
      if (!b.ok || !isNum(b.v)) return false;
      for (let i = 0; i < SEEDS.length; i++) {
        const sp = solP[SEEDS[i]].tryGet(sheetName, col, row);
        if (sp.ok && isNum(sp.v) && !near(sp.v, b.v, tol)) return false;
      }
      return !probeSensitive(
        function (ov) {
          return new FML.Workbook(model, FML.makeGetter(model, {}, true, { override: ov }));
        },
        wbS, refsOf(def.sol, sheetName), sheetName, col, row, tol);
    };

    /* 全表统计。
       correct 是「答对了几格」，solo 是「其中几格是没看提示自己做出来的」。
       两个数分开，是因为它们回答的问题不同：前者是进度，后者才是掌握程度。
       只有 correct 的话，一路看答案填完也是 100%，那个数字没有意义。 */
    g.scan = function (solo) {
      let correct = 0, total = 0, filled = 0, soloCorrect = 0, assisted = 0;
      (model.sheets || []).forEach(function (sh) {
        (sh.rows || []).forEach(function (r, ri) {
          const rowNum = ri + 2;
          (r.cells || []).forEach(function (cell, ci) {
            if (!cell || cell.kind !== 'input') return;
            total++;
            const key = sh.name + '!' + FML.addr(ci + 1, rowNum);
            const v = g.of(sh.name, ci + 1, rowNum);
            const isSolo = solo ? solo(key) : true;
            if (!isSolo) assisted++;
            if (v.code === 'blank') return;
            filled++;
            if (v.ok) { correct++; if (isSolo) soloCorrect++; }
          });
        });
      });
      return {
        correct: correct, total: total, filled: filled,
        soloCorrect: soloCorrect, assisted: assisted
      };
    };

    return g;
  };

  /* 判定结果的一句话说明，给格子的 tooltip 和状态栏用。
     完整的诊断文案在 diagnose.js 里。 */
  Grade.label = function (code) {
    switch (code) {
      case 'ok': return '正确';
      case 'err': return '公式算不出来';
      case 'solerr': return '参考答案在当前数据下算不出来';
      case 'value': return '结果和参考答案不一致';
      case 'const': return '结果对，但这一格是写死的常数，不是算出来的';
      case 'nonequiv': return '结果对，但公式和参考答案不等价';
      default: return '';
    }
  };

  global.Grade = Grade;
})(window);
