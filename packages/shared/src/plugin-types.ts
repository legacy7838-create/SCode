/**
 * 插件展示元数据（Store Listing）：目录/参考 catalog 条目携带的 display-only 字段。
 *
 * 全部可选，缺失时 UI 按降级矩阵处理（字母头像/隐藏区块/省略信息行）。i18n 采用
 * `<字段>I18n` map，locale 解析复用同目录的 plugin-display-name helper。
 * 它只服务展示，不参与身份判定、启停、安装门禁或权限判断。
 */
export interface PluginStoreListing {
  displayName?: string;
  displayNameI18n?: Record<string, string>;
  descriptionI18n?: Record<string, string>;
  icon?: string;
  category?: string;
  author?: string;
  authorUrl?: string;
  homepage?: string;
  privacyPolicy?: string;
  termsOfService?: string;
  heroImage?: string;
  examplePrompts?: string[];
  examplePromptsI18n?: Record<string, string[]>;
  /**
   * 需要付费套餐才好用的插件：目录条目声明 `requiresPaidPlan: true`，
   * UI 在标题右侧展示提示图标。描述的是「使用条件」而非「插件是收费商品」——
   * 不参与安装门禁与计费，命名也不绑定具体套餐商品名。
   */
  requiresPaidPlan?: boolean;
}

/** 设置页资源 scope：与插件启停无关，只表示条目归属哪一层配置。 */
export type PluginScope = "workspace" | "user";
