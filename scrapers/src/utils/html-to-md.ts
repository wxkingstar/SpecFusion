/**
 * HTML → Markdown 通用工具
 *
 * 注意：各平台适配器（WecomSource、FeishuSource）已各自内置了
 * 专用的 HTML 转换管线，因为每个平台的 HTML 结构差异很大。
 *
 * 本模块提供一些通用的辅助函数，供适配器按需调用。
 */

/** 清理多余空行，保留最多两个连续换行 */
export function collapseBlankLines(text: string): string {
  return text.replace(/\n{3,}/g, '\n\n');
}

/** 移除 HTML 注释 */
export function stripHtmlComments(text: string): string {
  return text.replace(/<!--[\s\S]*?-->/g, '');
}

/** 清理常见的 HTML 实体 */
export function decodeBasicEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

/** 移除所有 HTML 标签，保留内文本 */
export function stripAllTags(html: string): string {
  return html.replace(/<[^>]+>/g, '');
}

/** 将 <br> 系列标签转为换行 */
export function brToNewline(html: string): string {
  return html.replace(/<br\s*\/?>/gi, '\n');
}
