/* ============================================================================
 * provenance.js —— 数据口径与溯源
 *
 * 币种、量级、财年口径是**正确性问题**，不只是可信度问题：
 * 学生分不清一张表是「百万元」还是「元」、是自然年还是 9 月底结账的财年，
 * 算出来的东西直接是错的，而且这种错不会触发任何校验。
 *
 * 这里做四件事：
 *
 *   derive(model)     从已有的结构化字段推口径 —— sheet.unit 和表头里的年份标记。
 *                     全部模型都能推出来，不需要人工填，也就不会写着写着过期。
 *
 *   fieldKind(...)    每一个给定格属于哪一类：原始披露 / 换算或近似 / 预测假设 / 教学假设，
 *                     以及有没有标「待核」。按格子自己的标注判断，不看整段 dataNote。
 *
 *   status(model)     模型级的溯源状态：构造 / 未标注 / 已标注未核 / 部分核对 / 已核对。
 *
 *   gaps(model)       列出只有人能填、推不出来的部分：原始公告链接、页码、
 *                     数据截止日、还没核的范围。这些**不编**，缺就明确显示缺。
 *
 * ---------------------------------------------------------------------------
 * 模型是不是「纯教学构造」，由模型自己声明，不再用正则去猜 dataNote：
 *
 *   dataKind: 'synthetic'      没有任何真实公司或外部统计数据，没有原文可指
 *
 * 不声明就视为含真实 / 外部数据，需要溯源；是 'real' 还是 'mixed'（真实历史 + 预测或教学假设）
 * 由 fieldKind 的盘点推出来。旧版按「全部为教学假设」之类的字样整张豁免，
 * 把 aapl-dcf、belle-lbo-full 这种「真实历史 + 假设预测」的模型错标成了构造数据——
 * 说明里的一句「预测期全部为教学假设」不能豁免历史部分的溯源。
 *
 * ---------------------------------------------------------------------------
 * 含真实数据的模型用 source 块记录出处。每份文件写清楚**核了哪些数**：
 *
 *   source: {
 *     docs: [{
 *       title: 'Apple Inc. Form 10-K', period: 'FY2024',
 *       statement: '合并利润表', page: '29', url: 'https://...',
 *       covers: 'FY2022–FY2024 利润表全部给定值',       // 这份文件核对了哪些数
 *       verified: { by: '2026-09 外部核验', ref: 'USHK-08' }   // 没核过就写 false
 *     }],
 *     unverified: '…',          // 真实数据里还没核对的部分，写明白，不留空
 *     asOf: '2024-09-28',       // 数据截止日（财年结束日，不是发布日）
 *     version: '2026.09',
 *     updated: '2026-09-25'
 *   }
 *
 * 「已核对」只在所有文件都核过、并且 unverified 为空时才成立。
 * 只核了一部分就是「部分核对」——一个模型里有一个数没核，就不能整张标「已核对」。
 * ==========================================================================*/
(function (global) {
  'use strict';

  const Prov = {};

  /* unit 是自由文本，但写法足够一致，能可靠地认出币种和量级。
     认不出来的不猜，返回空数组，由 gaps() 报出去。 */
  const SCALE = [[/十亿/, '十亿'], [/亿/, '亿'], [/百万/, '百万'], [/万/, '万']];

  /* 先认外币，再把外币词去掉；如果还剩「元」，按中文财报惯例就是人民币
     （「百万元」「亿元」「万元」都是这么写的）。顺序不能反：
     「百万美元 / 美元」里也有「元」，先认美元才不会被算成两种币种。 */
  function currencyOf(unit) {
    const out = [];
    let rest = String(unit || '');
    if (/美元/.test(rest)) { out.push('美元 USD'); rest = rest.replace(/美元/g, ''); }
    if (/港元/.test(rest)) { out.push('港元 HKD'); rest = rest.replace(/港元/g, ''); }
    if (/欧元/.test(rest)) { out.push('欧元 EUR'); rest = rest.replace(/欧元/g, ''); }
    if (/日元/.test(rest)) { out.push('日元 JPY'); rest = rest.replace(/日元/g, ''); }
    if (/元/.test(rest)) out.push('人民币 CNY');
    return out;
  }

  function scanUnits(model) {
    const cur = {}, scale = {}, raw = {};
    (model.sheets || []).forEach(function (s) {
      const u = String(s.unit || '');
      raw[u] = true;
      currencyOf(u).forEach(function (c) { cur[c] = true; });
      /* 「百万」要先于「万」匹配，所以命中一个就停 */
      for (let i = 0; i < SCALE.length; i++) {
        if (SCALE[i][0].test(u)) { scale[SCALE[i][1]] = true; break; }
      }
    });
    return { currencies: Object.keys(cur), scales: Object.keys(scale), units: Object.keys(raw) };
  }

  /* 表头里的年份标记：2024 / FY2024 / 2024A / 2025E。
     FY 前缀说明不是自然年（苹果 9 月底结账），E 说明含预测期。 */
  const YEAR = /^(FY)?((?:19|20)\d{2})([AEF])?$/;

  function scanYears(model) {
    let lo = null, hi = null, fyPrefix = false, hasEst = false, seen = 0;
    (model.sheets || []).forEach(function (s) {
      (s.header || []).forEach(function (h) {
        const m = YEAR.exec(String(h || '').trim());
        if (!m) return;
        seen++;
        const y = parseInt(m[2], 10);
        if (lo === null || y < lo) lo = y;
        if (hi === null || y > hi) hi = y;
        if (m[1]) fyPrefix = true;
        if (m[3] === 'E' || m[3] === 'F') hasEst = true;
      });
    });
    return { from: lo, to: hi, fyPrefix: fyPrefix, hasEstimate: hasEst, count: seen };
  }

  /** 从已有结构化字段推出来的口径。不含任何人工填写的内容。 */
  Prov.derive = function (model) {
    const u = scanUnits(model);
    const y = scanYears(model);
    return {
      currencies: u.currencies,
      scales: u.scales,
      units: u.units,
      fiscalFrom: y.from,
      fiscalTo: y.to,
      /* FY 前缀 = 非自然年财年；没有年份列的模型（纯假设类）返回 null 而不是瞎猜 */
      fiscalBasis: y.count === 0 ? null : (y.fyPrefix ? '公司财年（非自然年）' : '自然年'),
      hasEstimate: y.hasEstimate,
      multiCurrency: u.currencies.length > 1
    };
  };

  /* ======================================================== 字段级分类 */

  /* 行 / 格 note 里的标注。「约数」「倒挤」这类不是假设，是由披露数据算出来或取整的值，
     单列一类，否则会把一个真实公司的近似股数说成「教学假设」。 */
  const RE_ASSUME = /假设|示例|教学输入|可改/;
  const RE_DERIVED = /倒挤|倒推|反推|约数|合并列示|合计，见|换算|近似|取整|推算/;
  const RE_UNVERIFIED = /待.*核|未核/;
  const RE_FORECAST_HDR = /\d{4}\s*E\b|E$|预测|情景/;
  /* 分节标题写着「教学假设」且没提真实 / 披露时，整节视为假设
     （例如「二、折现率参数（教学假设）」）。混写的分节标题不套用。 */
  const RE_SEC_REAL = /真实|披露|年报|报表|公告/;

  Prov.KINDS = {
    disclosed: '原始披露',
    derived: '换算或近似',
    forecast: '预测假设',
    assumption: '教学假设'
  };

  /** 给定格属于哪一类。sheet 是 sheet 对象，rowIdx 是 rows 下标，col 是 1 起的列号（B = 1）。 */
  Prov.fieldKind = function (model, sheet, rowIdx, col) {
    const r = (sheet.rows || [])[rowIdx] || {};
    const cd = (r.cells || [])[col - 1] || {};
    const notes = [r.note || '', cd.note || ''].join(' ');
    const out = { kind: 'disclosed', unverified: RE_UNVERIFIED.test(notes) };
    if (Prov.isSynthetic(model)) { out.kind = 'assumption'; out.unverified = false; return out; }
    if (RE_ASSUME.test(notes)) { out.kind = 'assumption'; return out; }
    if (RE_FORECAST_HDR.test(String((sheet.header || [])[col] || ''))) { out.kind = 'forecast'; return out; }
    if (RE_DERIVED.test(notes)) { out.kind = 'derived'; return out; }
    let sec = '';
    for (let i = rowIdx; i >= 0; i--) {
      const x = sheet.rows[i];
      if (x && x.style === 'sec') { sec = x.label || ''; break; }
    }
    if (RE_ASSUME.test(sec) && !RE_SEC_REAL.test(sec)) out.kind = 'assumption';
    return out;
  };

  /** 一个模型全部给定格的分类盘点。 */
  Prov.fieldTally = function (model) {
    const t = { disclosed: 0, derived: 0, forecast: 0, assumption: 0, unverified: 0, total: 0 };
    (model.sheets || []).forEach(function (sh) {
      (sh.rows || []).forEach(function (r, ri) {
        (r.cells || []).forEach(function (c, ci) {
          if (!c || c.kind !== 'given') return;
          const k = Prov.fieldKind(model, sh, ri, ci + 1);
          t[k.kind]++; t.total++;
          if (k.unverified) t.unverified++;
        });
      });
    });
    return t;
  };

  /* ======================================================== 模型级分类 */

  /** 纯教学构造：由模型显式声明，不看说明文字。 */
  Prov.isSynthetic = function (model) {
    return model.dataKind === 'synthetic';
  };

  /** synthetic / mixed（真实历史 + 预测或教学假设）/ real（只有真实与换算值） */
  Prov.kind = function (model) {
    if (Prov.isSynthetic(model)) return 'synthetic';
    if (model.dataKind === 'mixed' || model.dataKind === 'real') return model.dataKind;
    const t = Prov.fieldTally(model);
    return (t.forecast || t.assumption) ? 'mixed' : 'real';
  };

  /* 说明文字和声明对不上时交给人看：说明里说「不涉及任何真实公司」却没声明 synthetic，
     或者声明了 synthetic、说明里却提到年报 / 10-K。只报出来，不替人改分类。 */
  const RE_NOTE_SYN = /不涉及任何真实|不对应任何一家具体公司|不对应任何真实公司|不对应任何一个具体项目|不对应任何一家公司|不涉及任何真实品种|构造的最小算例/;
  const RE_NOTE_REAL = /10-K|年度报告|年报|招股书|公告披露|真实数据/;
  Prov.noteMismatch = function (model) {
    const note = String(model.dataNote || '');
    if (!Prov.isSynthetic(model) && RE_NOTE_SYN.test(note)) return '说明像构造数据，但没有声明 dataKind: synthetic';
    if (Prov.isSynthetic(model) && RE_NOTE_REAL.test(note) && !RE_NOTE_SYN.test(note)) return '声明为构造数据，但说明提到真实出处';
    return '';
  };

  function isVerified(d) { return !!(d && d.verified); }

  /** 溯源状态：synthetic 构造 / none 未标注 / stated 已标注未核 / partial 部分核对 / verified 已核对 */
  Prov.status = function (model) {
    if (Prov.isSynthetic(model)) return 'synthetic';
    const s = model.source || {};
    if (!s.docs || !s.docs.length) return 'none';
    const n = s.docs.filter(isVerified).length;
    if (n === 0) return 'stated';
    const complete = n === s.docs.length && !s.unverified &&
      s.docs.every(function (d) { return d.url && (d.page || d.statement); });
    return complete ? 'verified' : 'partial';
  };

  /** 核对标记的文字：谁核的。 */
  Prov.verifiedBy = function (doc) {
    const v = doc && doc.verified;
    if (!v) return '';
    if (v === true) return '已核对';
    return '已核对' + (v.by ? '（' + v.by + (v.ref ? ' · ' + v.ref : '') + '）' : '');
  };

  /** 只有人能填的部分，缺什么列什么。构造数据返回空数组。 */
  Prov.gaps = function (model) {
    if (Prov.isSynthetic(model)) return [];
    const s = model.source || {};
    const out = [];
    if (!s.docs || !s.docs.length) out.push('原始文件（公告 / 年报 / 10-K 的名称与期间）');
    else {
      if (!s.docs.some(function (d) { return d.url; })) out.push('原文链接');
      if (!s.docs.some(function (d) { return d.page || d.statement; })) out.push('报表名或页码');
      if (!s.docs.some(isVerified)) out.push('对着原文核对（docs[].verified）');
      if (s.unverified) out.push('尚未核对的部分：' + s.unverified);
    }
    if (!s.asOf) out.push('数据截止日');
    if (!s.version) out.push('模型版本');
    if (!s.updated) out.push('最近更新日');
    const d = Prov.derive(model);
    if (!d.currencies.length) out.push('币种（unit 字段里认不出来）');
    if (!d.scales.length) out.push('量级（unit 字段里认不出来）');
    return out;
  };

  /** 给 UI 用的一行摘要。 */
  Prov.summary = function (model) {
    const d = Prov.derive(model);
    const bits = [];
    if (d.currencies.length) bits.push(d.currencies.join(' / '));
    if (d.scales.length) bits.push('以' + d.scales.join(' / ') + '为单位');
    if (d.fiscalFrom) {
      bits.push(d.fiscalFrom === d.fiscalTo ? String(d.fiscalFrom) : d.fiscalFrom + '–' + d.fiscalTo);
    }
    if (d.fiscalBasis) bits.push(d.fiscalBasis);
    if (d.hasEstimate) bits.push('含预测期');
    return bits.join(' · ');
  };

  global.Prov = Prov;
})(window);
