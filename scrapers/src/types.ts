/** 文档源适配器接口 */
export interface DocSource {
  /** 唯一标识 */
  id: string;
  /** 显示名称 */
  name: string;
  /** 获取完整文档目录 */
  fetchCatalog(): Promise<DocEntry[]>;
  /** 获取单篇文档内容 */
  fetchContent(entry: DocEntry): Promise<DocContent>;
  /** 检测自某时间以来的变更（增量同步） */
  detectUpdates(since: Date): Promise<DocEntry[]>;
}

export interface DocEntry {
  /** 文档路径层级 */
  path: string;
  /** 文档标题 */
  title: string;
  /** HTTP 接口路径（如 /cgi-bin/message/send） */
  apiPath?: string;
  /** 开发模式（仅企业微信）：internal / third_party / service_provider */
  devMode?: string;
  /** 文档类型：api_reference / guide / error_code / event / card_template / changelog */
  docType?: string;
  /** 官方原文链接 */
  sourceUrl?: string;
  /** 最后更新时间 */
  lastUpdated?: string;
  /** 平台稳定 ID（如企业微信的 doc_id） */
  platformId?: string;
}

export interface DocContent {
  /** Markdown 内容 */
  markdown: string;
  /** 从内容中提取的 HTTP 接口路径 */
  apiPath?: string;
  /** 从内容中提取的错误码列表 */
  errorCodes?: Array<{
    code: string;
    message?: string;
    description?: string;
  }>;
  /** 额外元信息 */
  metadata?: Record<string, unknown>;
}

/** 同步选项 */
export interface SyncOptions {
  /** 是否增量同步 */
  incremental?: boolean;
  /** 限制抓取数量（调试用） */
  limit?: number;
  /** API 服务地址 */
  apiUrl?: string;
  /** Admin Token */
  adminToken?: string;
}

/** 同步结果 */
export interface SyncResult {
  source: string;
  created: number;
  updated: number;
  unchanged: number;
  deleted: number;
  errors: number;
  duration: number;
}
