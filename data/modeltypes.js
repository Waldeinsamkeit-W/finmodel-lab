/* ============================================================================
 * modeltypes.js —— 模型类型（训练课程的一级分类）
 * 每个类型下按 简单 / 中级 / 复杂 三档组织训练。
 * ==========================================================================*/
(function () {
  'use strict';
  const DB = window.DB;
  DB.modelTypes = [];
  const add = function (x) { DB.modelTypes.push(x); return x; };

  add({
    id: 'stmt', name: '财报拆解与比率分析', en: 'Statement Analysis', icon: '▤', color: '#3b6df0',
    tagline: '把一张报表拆开，算清每一层利润率与效率指标',
    desc: '所有模型的地基。学会读懂利润表、资产负债表、现金流量表的结构，' +
      '把总量拆成率与量，再用杜邦、桥式分解等方法找出变化的真实来源。',
    skills: ['利润率分层', '杜邦分解', '桥式归因（bridge）', '单位经济', '口径统一']
  });

  add({
    id: 'three', name: '三表联动模型', en: '3-Statement Model', icon: '⊞', color: '#0d7d6c',
    tagline: '从真实三张报表出发，做到资产 = 负债 + 权益',
    desc: '财务建模的核心技能。以公司披露的历史三张报表为起点，' +
      '先做勾稽校验（桥），再提取驱动指标，然后预测利润表、推导资产负债表、' +
      '用间接法还原现金流，最后把期末现金送回资产负债表完成配平。',
    skills: ['三表勾稽校验', '周转天数驱动营运资本', '固定资产与权益滚动', '间接法现金流', '配平（balance check）']
  });

  add({
    id: 'dcf', name: 'DCF 估值', en: 'Discounted Cash Flow', icon: '◈', color: '#7c4dff',
    tagline: '自由现金流、WACC、终值，一路推到每股价值',
    desc: '把预测出来的自由现金流按资金成本折现。核心难点不在算术，' +
      '而在于理解终值通常占企业价值的六成以上——所以敏感性分析不是可选项。',
    skills: ['UFCF 构建', 'CAPM 与 WACC', '永续增长法终值', 'EV → 股权价值 → 每股', '二维敏感性表']
  });

  add({
    id: 'comps', name: '可比公司 / 先例交易', en: 'Comps & Precedents', icon: '⋈', color: '#c2513a',
    tagline: '相对估值：倍数怎么选、怎么调、怎么用',
    desc: '用同行的估值倍数给目标定价。关键在口径统一——' +
      '分子分母必须匹配（EV 对 EBITDA，市值对净利润），并对增速与利润率差异做调整。',
    skills: ['EV/EBITDA 与 P/E 的匹配', '口径调平', '中位数 vs 均值', 'PEG 与其适用边界', '控制权溢价']
  });

  add({
    id: 'forecast', name: '行业驱动盈利预测', en: 'Driver-based Forecast', icon: '↗', color: '#1a8c6d',
    tagline: '收入 = 量 × 价，把预测落到可验证的业务驱动上',
    desc: '不给总收入拍增长率，而是拆到销量、单价、产能利用率、分部结构这些' +
      '能被行业数据验证的驱动因子上，再逐层加总。',
    skills: ['量价拆解', '分部加总（build-up）', '产能与利用率', '假设与计算分离', '增长贡献度分解']
  });

  add({
    id: 'lbo', name: 'LBO 杠杆收购', en: 'Leveraged Buyout', icon: '◆', color: '#a0762c',
    tagline: '来源与用途、债务表、退出回报与归因',
    desc: '私募股权的核心模型。用债务放大股权回报，靠经营改善、倍数扩张、' +
      '债务偿还三条路径创造价值——学会把回报拆开，才知道钱是怎么赚到的。',
    skills: ['Sources & Uses', '现金扫还与债务表', 'MOIC / IRR', '回报三分解', '退出倍数敏感性']
  });

  add({
    id: 'ma', name: 'M&A 并购模型', en: 'Merger Model', icon: '⇉', color: '#c0344a',
    tagline: '增厚 / 摊薄、换股比例、备考报表',
    desc: '判断一笔交易对收购方每股收益是好是坏。现金收购看放弃的利息收入，' +
      '换股收购看双方市盈率的高低——这两条经验法则能解释绝大多数结论。',
    skills: ['备考净利润搭建', 'Accretion / Dilution', '换股比例与发行股数', '盈亏平衡协同', '价格桥（EV ↔ 股权价值）']
  });

  add({
    id: 'sotp', name: '分部估值 SOTP', en: 'Sum of the Parts', icon: '◫', color: '#8248c9',
    tagline: '业务分开定价，再加总回来',
    desc: '当一家公司的几块业务属性完全不同（增速、利润率、风险都不一样），' +
      '用一个统一倍数会严重失真。SOTP 把它们拆开分别估值，再扣掉净负债与控股折价。',
    skills: ['分部利润还原', '分部倍数选取', '未上市股权与投资资产', '控股折价', '加总校验']
  });

  add({
    id: 'bank', name: '金融机构模型', en: 'Financial Institutions', icon: '⛁', color: '#b03a2e',
    tagline: '银行三表逻辑完全不同：规模 × 息差、拨备、PB–ROE',
    desc: '银行没有营业成本和毛利率，资产负债表本身就是产品。' +
      '收入来自生息资产规模乘净息差，利润被拨备调节，估值用 PB–ROE 而不是 DCF。',
    skills: ['规模—价格分解', '净息差 NIM', '拨备与信用成本', '成本收入比', 'PB–ROE 框架']
  });

  add({
    id: 'equity', name: '股权结构与融资', en: 'Cap Table & Financing', icon: '◍', color: '#2b8fa8',
    tagline: '投前投后、稀释、各轮回报',
    desc: '一级市场最基础的一张表。所有条款谈判最后都要落到"谁占多少股"，' +
      '以及退出时每一方能分到多少。',
    skills: ['投前 / 投后估值', '每股价格与发行股数', '逐轮稀释', 'MOIC 与 IRR', '期权池与优先权（进阶）']
  });

  add({
    id: 'macct', name: '并购会计与合并报表', en: 'Acquisition Accounting', icon: '⊟', color: '#8c4a5f',
    tagline: '交易做完，账上会变成什么样',
    desc: '前面几类回答"值不值、摊不摊薄"，这一类回答"合并报表长什么样"。' +
      '对价怎么分摊到可辨认净资产、剩下多少变成商誉、识别出来的无形资产未来怎么摊销、' +
      '同一控制下合并为什么根本不产生商誉——这些是并购独有的会计，通用财务建模课里学不到。',
    skills: ['购买价格分摊 PPA', '商誉的产生与减值', '无形资产识别与摊销', '递延所得税负债', '同一控制 vs 非同一控制']
  });

  add({
    id: 'struct', name: '交易结构与对价设计', en: 'Deal Structuring', icon: '⌥', color: '#3b7d8c',
    tagline: '同样的估值，条款不同，双方拿到的钱完全不同',
    desc: '估值谈完只是开始。对价怎么付、分几期付、付多少看业绩、达不到怎么补——' +
      '这些条款决定了风险由谁承担。中国市场的对赌与业绩承诺几乎是标配，' +
      '它把"一个价格"变成了"一条收益曲线"。',
    skills: ['业绩承诺与补偿公式', '或有对价 earnout', '股份补偿 vs 现金补偿', '触发点与补偿上限', '条款对双方收益分布的影响']
  });

  add({
    id: 'biotech', name: '生物医药与管线估值', en: 'Biotech & Pipeline Valuation', icon: '⚗', color: '#7a9a3f',
    tagline: '把成功概率乘进现金流，再面对一个终值为 0 的世界',
    desc: 'rNPV 在形式上是 DCF，但三件事完全不同：收入靠患者数与渗透率一层层推出来，' +
      '每期现金流要乘上累计临床成功率，而专利到期之后现金流断崖式归零——' +
      '**终值不是永续增长，是 0**。再加上一个最经典的陷阱：现金流已经按概率折过了，' +
      '折现率就不能再用"生物科技风险高"当理由往上抬，否则同一个风险被扣了两遍。',
    skills: ['分阶段成功率与累计概率', '峰值销售的量价渗透拆解', '专利悬崖与终值为 0', '避免风险双重计算', '管线加总与授权里程碑']
  });

  add({
    id: 'insurance', name: '保险公司估值', en: 'Insurance Valuation', icon: '⛨', color: '#4a6fa5',
    tagline: '综合成本率、内含价值、新业务价值——一套完全独立的口径',
    desc: '保险是少数几个通用估值方法整个失效的行业。财险的"毛利率"叫综合成本率，' +
      '越低越好且超过 100% 不代表亏钱；寿险卖一张二十年期保单，当年会计利润接近于零，' +
      '所以不能用市盈率，要用内含价值 EV 和新业务价值 NBV。' +
      '而 EV 建立在一长串长期假设上，读它的关键不是看有多大，是看它一年之内怎么变。',
    skills: ['综合成本率与承保利润', '承保 + 投资双利润来源', 'EV = 调整净资产 + 有效业务价值', 'NBV 与渠道价值率', 'EV 变动分析与 P/EV']
  });

  add({
    id: 'realestate', name: '不动产与项目融资', en: 'Real Estate & Project Finance', icon: '⌂', color: '#96703a',
    tagline: 'NOI 与 Cap Rate 估值、DSCR 与偿债能力、开发项目 IRR',
    desc: '不动产估值不用 DCF，用直接资本化法：价值 = NOI ÷ Cap Rate。' +
      '难点在 NOI 的口径（不扣利息、折旧、税与资本开支）和 Cap Rate 的来源（观察值而非计算值）。' +
      '融到贷款那一步视角要切换：贷款人不看上行只看下行，关心 LTV、DSCR 与债务收益率。' +
      '而开发项目又是另一套——没有终值，利润是既定的，回报率完全由回款时间决定。',
    skills: ['NOI 三层结构', '直接资本化法与 Cap Rate 敏感性', 'LTV / DSCR / 债务收益率', '契约测试与压力测试', '开发项目现金流与股权 IRR']
  });

  add({
    id: 'credit', name: '信用分析：债权人视角', en: 'Credit Analysis', icon: '⊘', color: '#6b5b95',
    tagline: '收益封顶、损失不封顶——所以只看下行',
    desc: '股东的收益无上限，所以看增长；债权人最好的结果只是按时收回本息，' +
      '所以全部注意力都在"最坏会怎样"。这个不对称决定了信用分析用的是倍数而不是增长率：' +
      '杠杆倍数、覆盖倍数、契约 headroom。而违约之后还有第二个问题——' +
      '同一家公司只有一个企业价值，但债务分好几层，你持有哪一层决定了是全额收回还是血本无归。',
    skills: ['净债务/EBITDA 与覆盖倍数', 'FFO 与债权人现金流口径', '财务契约测试与 headroom', 'EBITDA 加回的操纵空间', '清偿瀑布与回收率', '预期损失 = PD × LGD']
  });

  /* ------------------------------------------------------------------
   * 把已有模型挂到类型上
   * ---------------------------------------------------------------- */
  const MAP = {
    'aapl-income': 'stmt',
    'tsla-unit': 'stmt',
    'moutai-mix': 'stmt',
    'aapl-dupont': 'stmt',
    'catl-bridge': 'stmt',
    'nvda-oplev': 'stmt',
    'hengrui-rd': 'stmt',
    'yili-vs-moutai': 'comps',
    'tcent-seg': 'forecast',
    'cmb-nim': 'bank',
    'byd-3s': 'three',
    'aapl-dcf': 'dcf',
    'vc-captable': 'equity',
    'belle-lbo-basic': 'lbo',
    'belle-lbo-full': 'lbo',
    'msft-atvi': 'ma',
    'mindray-huitai': 'ma',
    'cssc-merger': 'ma'
  };

  DB.applyTypes = function () {
    DB.models.forEach(function (m) { if (!m.type && MAP[m.id]) m.type = MAP[m.id]; });
  };
})();
