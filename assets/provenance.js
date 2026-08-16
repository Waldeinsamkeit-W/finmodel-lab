/* ============================================================================
 * provenance.js —— 数据口径
 *
 * 币种、量级、财年口径是**正确性问题**，不只是可信度问题：
 * 学生分不清一张表是「百万元」还是「元」、是自然年还是 9 月底结账的财年，
 * 算出来的东西直接是错的，而且这种错不会触发任何校验。
 *
 * 这里做两件事：
 *
 *   derive(model)  从已有的结构化字段推口径 —— sheet.unit 和表头里的年份标记。
 *                  全部 56 个模型都能推出来，不需要人工填，也就不会写着写着过期。
 *
 *   gaps(model)    列出只有人能填、推不出来的部分：原始公告链接、页码、
 *                  数据截止日、复核人。这些**不编**，缺就明确显示缺。
 *
 * 模型可以声明一个可选的 source 块补上后者：
 *
 *   source: {
 *     docs: [{ title:'Apple Inc. Form 10-K', period:'FY2024',
 *              statement:'合并利润表', page:'31', url:'https://...' }],
 *     asOf: '2024-09-28',        // 数据截止日（财年结束日，不是发布日）
 *     version: '2024.1',
 *     updated: '2026-08-16',
 *     reviewedBy: null           // 没有第三方复核就写 null，别填自己
 *   }
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

  /** 只有人能填的部分，缺什么列什么。 */
  Prov.gaps = function (model) {
    const s = model.source || {};
    const out = [];
    if (!s.docs || !s.docs.length) out.push('原始文件（公告 / 年报 / 10-K 的名称与期间）');
    else {
      if (!s.docs.some(function (d) { return d.url; })) out.push('原文链接');
      if (!s.docs.some(function (d) { return d.page || d.statement; })) out.push('报表名或页码');
    }
    if (!s.asOf) out.push('数据截止日');
    if (!s.version) out.push('模型版本');
    if (!s.updated) out.push('最近更新日');
    /* reviewedBy 不算缺口：没有第三方复核时，如实留空比填自己更可信 */
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
