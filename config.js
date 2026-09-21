/* ============================================================================
 * config.js —— 账号系统配置
 *
 * 不填这两个值，整个站就和以前完全一样：进度只存本地，不显示任何登录入口。
 * 填上之后才会出现「登录 / 注册」和「班级看板」。
 *
 * 去 Supabase 后台 → Project Settings → API 抄这两个值：
 *   URL      形如 https://xxxxxxxx.supabase.co
 *   anon key 很长的一串，以 eyJ 开头
 *
 * ⚠️ anon key 是设计上就可以公开的（它受数据库的行级安全策略约束），
 *    写进前端没问题。但同一页上还有一个 service_role key，
 *    那个是真正的万能钥匙，**绝对不能**出现在前端代码或 git 仓库里。
 * ==========================================================================*/
window.FML_CONFIG = {
  SUPABASE_URL: '',
  SUPABASE_ANON_KEY: '',

  /* 正式地址和源码仓库。
     使用说明页会显示这两个链接；在别处打开（claude.ai 制品、单文件版、别人镜像）时，
     首页顶部会提示正式地址。清空就都不显示。 */
  SITE_URL: 'https://waldeinsamkeit-w.github.io/finmodel-lab/',
  REPO_URL: 'https://github.com/Waldeinsamkeit-W/finmodel-lab'
};
