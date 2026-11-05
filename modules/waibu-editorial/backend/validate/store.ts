// 校验结果的读写：导出只认最近一次 passed。
import type { Db, Tx } from "@aihot/backend/db";
import type { ValidationReport, ValidationStatus } from "./index.ts";
import { assertValidationPassed } from "./index.ts";
import { EditorialError } from "../../contracts/errors.ts";
import { jsonValue } from "../store/rows.ts";

export interface StoredValidation {
  id: string;
  revision_id: string;
  validator: string;
  version: string;
  status: ValidationStatus;
  report: ValidationReport;
  screenshots: string[];
  created_at: string;
}

export async function saveValidation(
  db: Db | Tx,
  input: { revision_id: string; report: ValidationReport; screenshots?: string[] },
): Promise<StoredValidation> {
  const [row] = await db`
    insert into waibu_validations (revision_id, validator, version, status, report, screenshots, created_at)
    values (${input.revision_id}, ${input.report.validator}, ${`${input.report.version}+${input.report.spec_commit.slice(0, 8)}`}, ${input.report.status}, ${JSON.stringify(input.report)}::jsonb, ${input.screenshots ?? []}, clock_timestamp())
    returning id, revision_id, validator, version, status, report, screenshots, created_at`;
  return {
    ...row as StoredValidation,
    report: input.report,
    created_at: new Date(row!.created_at as string).toISOString(),
  };
}

export async function latestValidation(db: Db | Tx, revisionId: string): Promise<StoredValidation | null> {
  const [row] = await db`
    select id, revision_id, validator, version, status, report, screenshots, created_at
    from waibu_validations where revision_id = ${revisionId} order by created_at desc limit 1`;
  if (!row) return null;
  return {
    ...row as StoredValidation,
    // jsonb 读回来可能是字符串，统一解析后再用
    report: jsonValue<ValidationReport>(row.report),
    created_at: new Date(row.created_at as string).toISOString(),
  };
}

/** 导出闸门：没有通过校验的版本不能生成正式包。 */
export async function assertRevisionValidated(db: Db | Tx, revisionId: string): Promise<StoredValidation> {
  const validation = await latestValidation(db, revisionId);
  if (!validation) {
    throw new EditorialError("validation_failed", "这一版还没有排版校验记录，不能导出；请先运行校验");
  }
  assertValidationPassed(validation.report);
  return validation;
}
