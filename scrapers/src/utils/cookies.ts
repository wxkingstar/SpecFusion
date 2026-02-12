import fs from 'fs-extra';
import path from 'path';

export interface CookieEntry {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
}

/**
 * 从 JSON 文件加载 Cookie
 * 支持两种格式：
 * 1. EditThisCookie 导出格式（数组）
 * 2. 简单 key-value 对象
 */
export function loadCookiesFromFile(filePath: string): CookieEntry[] {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    return [];
  }

  const raw = fs.readFileSync(resolved, 'utf-8');
  const data = JSON.parse(raw);

  if (Array.isArray(data)) {
    // EditThisCookie 格式
    return data.map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.domain || '',
      path: c.path || '/',
      expires: c.expirationDate ? Math.floor(c.expirationDate) : undefined,
      httpOnly: c.httpOnly ?? false,
      secure: c.secure ?? false,
    }));
  }

  // 简单 key-value 格式
  if (typeof data === 'object' && data !== null) {
    return Object.entries(data).map(([name, value]) => ({
      name,
      value: String(value),
      domain: '',
      path: '/',
    }));
  }

  return [];
}

/**
 * 保存 Cookie 到 JSON 文件
 */
export function saveCookiesToFile(filePath: string, cookies: CookieEntry[]): void {
  const resolved = path.resolve(filePath);
  fs.writeFileSync(resolved, JSON.stringify(cookies, null, 2), 'utf-8');
}

/**
 * 将 CookieEntry 数组转为 Cookie 头字符串
 */
export function toCookieHeader(cookies: CookieEntry[]): string {
  return cookies.map((c) => `${c.name}=${c.value}`).join('; ');
}

/**
 * 从环境变量解析 Cookie 字符串
 * 格式: "name1=value1; name2=value2"
 */
export function parseCookieString(cookieStr: string): CookieEntry[] {
  if (!cookieStr || !cookieStr.trim()) return [];

  return cookieStr
    .split(';')
    .map((pair) => pair.trim())
    .filter(Boolean)
    .map((pair) => {
      const eqIdx = pair.indexOf('=');
      if (eqIdx < 0) return null;
      return {
        name: pair.slice(0, eqIdx).trim(),
        value: pair.slice(eqIdx + 1).trim(),
        domain: '',
        path: '/',
      };
    })
    .filter((c): c is CookieEntry => c !== null);
}
