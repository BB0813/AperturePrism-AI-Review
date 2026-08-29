import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  authHeaders,
  eventsUrl,
  getToken,
  notifyUnauthorized,
  onUnauthorized,
  setToken,
} from "../lib/auth";

describe("auth token storage", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("get/set/clear token in localStorage", () => {
    expect(getToken()).toBe("");
    setToken("abc");
    expect(getToken()).toBe("abc");
    setToken("");
    expect(getToken()).toBe("");
    setToken("  ");
    expect(getToken()).toBe("  ");
  });

  it("authHeaders returns the Bearer header only when a token is stored", () => {
    expect(authHeaders()).toEqual({});
    setToken("tok");
    expect(authHeaders()).toEqual({ authorization: "Bearer tok" });
  });

  it("eventsUrl appends a URL-encoded token query param", () => {
    expect(eventsUrl()).toBe("/events");
    setToken("a b&c");
    expect(eventsUrl()).toBe("/events?token=a%20b%26c");
  });
});

describe("notifyUnauthorized", () => {
  it("calls the registered handler once per 401 and stays silent without one", () => {
    const handler = vi.fn();
    onUnauthorized(handler);
    notifyUnauthorized();
    notifyUnauthorized();
    expect(handler).toHaveBeenCalledTimes(2);
    onUnauthorized(null);
    notifyUnauthorized();
    expect(handler).toHaveBeenCalledTimes(2);
  });
});
