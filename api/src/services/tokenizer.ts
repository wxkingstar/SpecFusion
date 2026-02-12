import nodejieba from 'nodejieba';
import path from 'node:path';
import fs from 'node:fs';
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
 * 查找 userdict.txt 的路径。
 * 优先使用环境变量 USERDICT_PATH，否则按相对路径查找 scrapers/config/userdict.txt。
 */
function resolveUserDictPath(): string {
  if (process.env.USERDICT_PATH) {
    return process.env.USERDICT_PATH;
  }

  // 从 api/src/services/ 向上查找
  const candidates = [
    path.resolve(__dirname, '../../scrapers/config/userdict.txt'),     // 源码运行: api/src/services/ → api/ → 项目根 → scrapers/config/
    path.resolve(__dirname, '../../../scrapers/config/userdict.txt'),   // dist 运行: api/dist/ → api/ → 项目根 → scrapers/config/
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return '';
}

/**
 * 初始化分词器，加载自定义词典。
 * API 端与 scraper 端使用同一份词典，保证分词一致性。
 */
export function initTokenizer(userDictPath?: string): void {
  if (initialized) return;

  const dictPath = userDictPath ?? resolveUserDictPath();

  const loadOptions: { userDict?: string } = {};
  if (dictPath) {
    loadOptions.userDict = dictPath;
  }

  nodejieba.load(loadOptions);
  initialized = true;
}

/**
 * 对文本进行分词，返回空格分隔的 token 字符串。
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
  const seen = new Set<string>();
  return result.split(' ').filter(t => {
    if (seen.has(t)) return false;
    seen.add(t);
    return true;
  }).join(' ');
}

function isPunctuation(s: string): boolean {
  return /^[\s，。、；：？！\u201C\u201D\u2018\u2019（）【】《》—…·,.;:?!'"()\[\]{}<>~`@#$%^&*+=|\\\-_\r\n\t]+$/.test(s);
}

function segmentText(text: string, forSearch = false): string {
  if (!text || !text.trim()) return '';

  const tokens: string[] = [];
  let lastIndex = 0;

  PROTECTED_RE.lastIndex = 0;

  let match: RegExpExecArray | null;
  while ((match = PROTECTED_RE.exec(text)) !== null) {
    if (match.index > lastIndex) {
      const chinesePart = text.slice(lastIndex, match.index);
      processChineseSegment(chinesePart, tokens, forSearch);
    }

    tokens.push(match[0]);
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < text.length) {
    const chinesePart = text.slice(lastIndex);
    processChineseSegment(chinesePart, tokens, forSearch);
  }

  return tokens.join(' ');
}

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
