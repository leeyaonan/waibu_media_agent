// 历史选题去重。两条规则要同时成立：
// 1. 同事件同角度不重复起草——重复调度、重跑都不能再写一遍；
// 2. 新进展不能被旧事件一刀切排除——同样的故事有了更新的材料，应该能开新候选。
//
// 判断依据是“故事 + 角度”的去重键，以及这个故事的素材是否比最后一次选题更新。
import type { Db } from "@aihot/backend/db";
import type { Candidate } from "./rank.ts";
import type { StoryMaterials } from "../materials/adapter.ts";

export type TopicDecision =
  | { action: "create"; reason: string }
  | { action: "follow_up"; reason: string; previous_topic_id: string }
  | { action: "skip"; reason: string; existing_topic_id: string };

/** 这个去重键是否已经用过。唯一约束之外的第一道判断，避免把异常抛给用户。 */
export async function findByDedupeKey(db: Db, dedupeKey: string): Promise<{ id: string; angle: string; created_at: string } | null> {
  const [row] = await db`select id, angle, created_at from waibu_topics where dedupe_key = ${dedupeKey} limit 1`;
  return row ? { id: String(row.id), angle: String(row.angle), created_at: new Date(row.created_at as string).toISOString() } : null;
}

/** 这个事件最近一次被选题是什么时候。 */
export async function lastTopicForStory(db: Db, storyId: number): Promise<{ id: string; created_at: string } | null> {
  const [row] = await db`
    select id, created_at from waibu_topics
    where ${storyId} = any(story_ids)
    order by created_at desc limit 1`;
  return row ? { id: String(row.id), created_at: new Date(row.created_at as string).toISOString() } : null;
}

/** 素材里最新的原文发布时间；没有可信时间时返回 null。 */
export function latestPublishedAt(materials: StoryMaterials): string | null {
  return materials.sources
    .map((item) => item.published_at)
    .filter((value): value is string => Boolean(value))
    .sort()
    .at(-1) ?? null;
}

/**
 * 这个候选该不该开新稿：
 * - 同键存在 → skip（重复调度不再起草）；
 * - 同故事但素材比上次选题新 → follow_up（新进展值得再写）；
 * - 否则 create。
 */
export async function decideTopic(db: Db, candidate: Candidate, materials: StoryMaterials): Promise<TopicDecision> {
  const same = await findByDedupeKey(db, candidate.dedupe_key);
  if (same) {
    return { action: "skip", reason: `同事件同角度已经写过（${same.created_at}）`, existing_topic_id: same.id };
  }

  const previous = await lastTopicForStory(db, candidate.story_id);
  const newest = latestPublishedAt(materials);
  if (previous && newest && new Date(newest) > new Date(previous.created_at)) {
    return {
      action: "follow_up",
      reason: `这个事件上次写到 ${previous.created_at}，之后又有新发布（${newest}）`,
      previous_topic_id: previous.id,
    };
  }

  return { action: "create", reason: candidate.reason };
}
