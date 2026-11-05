// 写请求去重。作者点了两次“提交意见”、网络重发、刷新后重试，都只应该产生一份改稿。
//
// 做法：把 Idempotency-Key 与请求体 hash 一起落库，重复请求直接返回第一次的结果；
// 同一个键配了不同的请求体则明确报错，不猜作者想要哪一个。
import type { Db, Tx } from "@aihot/backend/db";
import { EditorialError } from "../../contracts/errors.ts";
import { inputHash } from "../../contracts/content.ts";

export interface IdempotencyRecord<T> {
  /** true 表示这次是重复请求，返回的是已存结果。 */
  replayed: boolean;
  response: T;
}

import { jsonValue as asObject } from "../store/rows.ts";

export function requestHashOf(body: unknown): string {
  return inputHash(body);
}

/**
 * 带幂等键执行一次。key 为空时直接执行（不强制所有写请求都带键）。
 * fn 必须自己完成业务写入；返回值会被序列化保存。
 */
export async function withIdempotency<T>({
  db,
  key,
  actor,
  path,
  requestHash,
  run,
}: {
  db: Db;
  key: string | null;
  actor: string;
  path: string;
  requestHash: string;
  run: () => Promise<T>;
}): Promise<IdempotencyRecord<T>> {
  if (!key) return { replayed: false, response: await run() };

  const [existing] = await db`
    select request_hash, response from waibu_idempotency where key = ${key} limit 1`;
  if (existing) {
    if (String(existing.request_hash) !== requestHash) {
      throw new EditorialError("idempotency_conflict", "同一个 Idempotency-Key 被用于不同的请求内容", { key });
    }
    return { replayed: true, response: asObject<T>(existing.response) };
  }

  const response = await run();
  // 键先被别的请求抢占时（并发），以已存的为准，本次结果丢弃。
  const inserted = await db`
    insert into waibu_idempotency (key, actor, path, request_hash, response)
    values (${key}, ${actor}, ${path}, ${requestHash}, ${JSON.stringify(response)}::jsonb)
    on conflict (key) do nothing
    returning key`;
  if (inserted.length === 0) {
    const [stored] = await db`select request_hash, response from waibu_idempotency where key = ${key}`;
    if (stored && String(stored.request_hash) !== requestHash) {
      throw new EditorialError("idempotency_conflict", "同一个 Idempotency-Key 被用于不同的请求内容", { key });
    }
    return { replayed: true, response: stored ? asObject<T>(stored.response) : response };
  }
  return { replayed: false, response };
}

/** 清理过期幂等记录：只保留最近 7 天，避免表无限增长。 */
export async function pruneIdempotency(tx: Tx, days = 7): Promise<number> {
  const removed = await tx`
    delete from waibu_idempotency where created_at < now() - ${String(days)}::int * interval '1 day'`;
  return removed.count;
}
