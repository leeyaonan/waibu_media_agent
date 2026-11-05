// 正文段落 → 事实编号的映射检查。模型可能编一个不存在的编号，
// 这种“悬空引用”必须在自检阶段拦下，否则审核页会显示一个点不开的证据。
export interface ClaimMapCheck {
  ok: boolean;
  /** 引用了不存在的事实编号。 */
  dangling: string[];
  /** 被引用到的事实编号。 */
  referenced: string[];
}

export function evaluateClaims(blockClaims: Readonly<Record<string, readonly string[]>>, validClaimIds: readonly string[]): ClaimMapCheck {
  const known = new Set(validClaimIds);
  const dangling: string[] = [];
  const referenced = new Set<string>();

  for (const ids of Object.values(blockClaims)) {
    for (const id of ids) {
      if (!known.has(id)) dangling.push(id);
      else referenced.add(id);
    }
  }

  return { ok: dangling.length === 0, dangling: [...new Set(dangling)], referenced: [...referenced] };
}

/** 正文里没有绑定任何事实的段落数：只作提示，不阻断。 */
export function unboundBlocks(blockClaims: Readonly<Record<string, readonly string[]>>): number {
  return Object.values(blockClaims).filter((ids) => ids.length === 0).length;
}
