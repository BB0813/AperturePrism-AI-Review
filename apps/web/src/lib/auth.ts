const STORAGE_KEY = "apertureprism.token";

export function getToken(): string {
  return typeof localStorage === "undefined"
    ? ""
    : (localStorage.getItem(STORAGE_KEY) ?? "");
}

export function setToken(token: string): void {
  if (token) localStorage.setItem(STORAGE_KEY, token);
  else localStorage.removeItem(STORAGE_KEY);
}

/** Returns `Authorization: Bearer <token>` when a token is stored. */
export function authHeaders(): Record<string, string> {
  const token = getToken();
  return token ? { authorization: `Bearer ${token}` } : {};
}

/** SSE endpoint carrying the token as a query param (EventSource cannot set headers). */
export function eventsUrl(): string {
  const token = getToken();
  const base = "/events";
  if (!token) return base;
  return `${base}?token=${encodeURIComponent(token)}`;
}

// 令牌失效全局回调：任一 API 返回 401 时触发，让应用回到登录页（真正的密码门禁）。
let unauthorizedHandler: (() => void) | null = null;

export function onUnauthorized(handler: (() => void) | null): void {
  unauthorizedHandler = handler;
}

export function notifyUnauthorized(): void {
  unauthorizedHandler?.();
}