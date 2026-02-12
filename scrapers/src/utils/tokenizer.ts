import nodejieba from 'nodejieba';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 停用词集合
const STOP_WORDS = new Set([
  '的', '了', '是', '在', '有', '和', '与', '或', '等', '把',
  '被', '对', '不', '也', '都', '而', '及', '到', '从', '以',
]);

// 需要保护的 pattern（按优先级排列）：
// 1. URL（http(s)://...）
// 2. API 路径（/cgi-bin/message/send）
// 3. 英文标识符含 scope（contact:user.base:readonly, access_token, webhook）
// 4. 纯数字序列（错误码如 40001）
const PROTECTED_RE = /https?:\/\/[^\s]+|\/[a-zA-Z0-9_\-/.]+(?:\/[a-zA-Z0-9_\-/.]+)+|[a-zA-Z][a-zA-Z0-9_]*(?::[a-zA-Z0-9_.]+)*|\d+/g;

let initialized = false;

/**
 * 初始化分词器，加载自定义词典。
 * 默认加载 scrapers/config/userdict.txt。
 */
export function initTokenizer(userDictPath?: string): void {
  if (initialized) return;

  const dictPath = userDictPath
    ?? path.resolve(__dirname, '../../config/userdict.txt');

  nodejieba.load({ userDict: dictPath });
  initialized = true;
}

/**
 * 对文本进行分词，返回空格分隔的 token 字符串。
 * 用于写入 tokenized_title 和 tokenized_content 字段。
 *
 * 测试用例：
 *   "发送应用消息" → "发送 应用消息"（"应用消息"为自定义词典词条）
 *   "access_token" → "access_token"
 *   "/cgi-bin/message/send" → "/cgi-bin/message/send"
 *   "调用该接口可以向指定的用户发送应用消息"
 *     → "调用 该 接口 可以 向 指定 用户 发送 应用消息"（去掉"的"）
 */
export function tokenize(text: string): string {
  if (!initialized) initTokenizer();
  return segmentText(text);
}

/**
 * 对搜索查询进行分词。
 * 使用 cutForSearch 进行更细粒度的切分，提高召回率。
 * 自动去重（cutForSearch 可能同时产生细粒度和粗粒度分词）。
 */
export function tokenizeForSearch(query: string): string {
  if (!initialized) initTokenizer();
  const result = segmentText(query, true);
  // cutForSearch 可能产生重复 token（如 "应用" "消息" "应用消息"），去重保留顺序
  const seen = new Set<string>();
  return result.split(' ').filter(t => {
    if (seen.has(t)) return false;
    seen.add(t);
    return true;
  }).join(' ');
}

/**
 * 判断一个字符串是否为纯标点/符号（不含有意义的文字）
 */
function isPunctuation(s: string): boolean {
  // 匹配纯标点符号
  return /^[\s，。、；：？！\u201C\u201D\u2018\u2019（）【】《》—…·,.;:?!'"()\[\]{}<>~`@#$%^&*+=|\\\-_\r\n\t]+$/.test(s);
}

/**
 * 核心分词逻辑：
 * 1. 用正则将文本拆分为"受保护片段"和"待分词片段"交替序列
 * 2. 受保护片段直接作为 token 保留
 * 3. 待分词片段（中文为主）交给 jieba 切分
 * 4. 过滤停用词和标点
 * 5. 用空格拼接返回
 */
function segmentText(text: string, forSearch = false): string {
  if (!text || !text.trim()) return '';

  const tokens: string[] = [];
  let lastIndex = 0;

  // 重置正则状态
  PROTECTED_RE.lastIndex = 0;

  let match: RegExpExecArray | null;
  while ((match = PROTECTED_RE.exec(text)) !== null) {
    // 处理 match 前面的中文文本
    if (match.index > lastIndex) {
      const chinesePart = text.slice(lastIndex, match.index);
      processChineseSegment(chinesePart, tokens, forSearch);
    }

    // 受保护的片段直接加入
    tokens.push(match[0]);
    lastIndex = match.index + match[0].length;
  }

  // 处理最后一段中文文本
  if (lastIndex < text.length) {
    const chinesePart = text.slice(lastIndex);
    processChineseSegment(chinesePart, tokens, forSearch);
  }

  return tokens.join(' ');
}

/**
 * 对中文文本片段进行 jieba 分词，过滤停用词和标点后追加到 tokens 数组。
 */
function processChineseSegment(text: string, tokens: string[], forSearch: boolean): void {
  if (!text.trim()) return;

  const cutFn = forSearch ? nodejieba.cutForSearch : nodejieba.cut;
  const segments = cutFn(text);

  for (const seg of segments) {
    const trimmed = seg.trim();
    if (!trimmed) continue;
    if (STOP_WORDS.has(trimmed)) continue;
    if (isPunctuation(trimmed)) continue;
    tokens.push(trimmed);
  }
}
