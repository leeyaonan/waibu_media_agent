// 读库结果统一转成契约形状：timestamptz 由 postgres.js 解析成 Date，契约里是带时区的 ISO 字符串。
// 日期列（business_date）在 SQL 里直接 cast 成 text，避免时区把业务日挪一天。
import type { z } from "zod";

export function toIso<T>(value: unknown): T {
  if (value instanceof Date) return value.toISOString() as T;
  if (Array.isArray(value)) return value.map((item) => toIso(item)) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) out[key] = toIso(item);
    return out as T;
  }
  return value as T;
}

/** 解析一行；表结构与契约漂移时立刻报错，而不是把错值带到页面和批准里。 */
export function row<S extends z.ZodType>(schema: S, value: unknown): z.infer<S> {
  return schema.parse(toIso(value));
}

export function rows<S extends z.ZodType>(schema: S, values: readonly unknown[]): z.infer<S>[] {
  return values.map((value) => row(schema, value));
}
