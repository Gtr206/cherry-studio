/**
 * Assistant Service - handles assistant CRUD operations
 *
 * Provides business logic for:
 * - Assistant CRUD operations
 * - Listing with optional filters
 */

import { application } from '@application'
import { assistantTable } from '@data/db/schemas/assistant'
import { assistantKnowledgeBaseTable, assistantMcpServerTable } from '@data/db/schemas/assistantRelations'
import { entityTagTable, tagTable } from '@data/db/schemas/tagging'
import { userModelTable } from '@data/db/schemas/userModel'
import type { DbType } from '@data/db/types'
import { loggerService } from '@logger'
import { DataApiErrorFactory } from '@shared/data/api'
import type { CreateAssistantDto, ListAssistantsQuery, UpdateAssistantDto } from '@shared/data/api/schemas/assistants'
import { type Assistant, DEFAULT_ASSISTANT_SETTINGS } from '@shared/data/types/assistant'
import type { UniqueModelId } from '@shared/data/types/model'
import type { Tag } from '@shared/data/types/tag'
import { and, asc, eq, inArray, isNull, or, type SQL, sql } from 'drizzle-orm'

import { pinService } from './PinService'
import { tagService } from './TagService'
import { nullsToUndefined, timestampToISO } from './utils/rowMappers'

const logger = loggerService.withContext('DataApi:AssistantService')

type AssistantRow = typeof assistantTable.$inferSelect

type AssistantRelationIds = Pick<Assistant, 'mcpServerIds' | 'knowledgeBaseIds'>

function createEmptyRelations(): AssistantRelationIds {
  return {
    mcpServerIds: [],
    knowledgeBaseIds: []
  }
}

/**
 * Look up the resolved name for a given `modelId` in the lookup map produced
 * by `getModelNamesByUniqueIds`. Explicit null for unbound assistants avoids
 * the empty-string fallback key pattern sprinkled through callers.
 */
function pickModelName(modelId: string | null | undefined, names: Map<string, string>): string | null {
  if (!modelId) return null
  return names.get(modelId) ?? null
}

function rowToAssistant(
  row: AssistantRow,
  relations: AssistantRelationIds = createEmptyRelations(),
  tags: Tag[] = [],
  modelName: string | null = null
): Assistant {
  const clean = nullsToUndefined(row)
  return {
    ...clean,
    // Preserve the T | null contract: `modelId` is legitimately nullable (R3 exception).
    modelId: row.modelId as UniqueModelId | null,
    mcpServerIds: relations.mcpServerIds,
    knowledgeBaseIds: relations.knowledgeBaseIds,
    createdAt: timestampToISO(row.createdAt),
    updatedAt: timestampToISO(row.updatedAt),
    tags,
    modelName
  }
}

export class AssistantDataService {
  private get db() {
    return application.get('DbService').getDb()
  }

  private async getActiveRowById(id: string): Promise<AssistantRow> {
    const [row] = await this.db
      .select()
      .from(assistantTable)
      .where(and(eq(assistantTable.id, id), isNull(assistantTable.deletedAt)))
      .limit(1)

    if (!row) {
      throw DataApiErrorFactory.notFound('Assistant', id)
    }

    return row
  }

  /**
   * Assert that a given `modelId` exists in `user_model`. Mirrors the
   * `assertTagsExist` pattern in `TagService`: pre-validate at the Service
   * boundary so the caller sees a `VALIDATION_ERROR` with a field-level
   * message, rather than letting SQLite's FK constraint surface as a raw
   * `DrizzleQueryError`.
   */
  private async assertModelExists(tx: Pick<DbType, 'select'>, modelId: string): Promise<void> {
    const [row] = await tx
      .select({ id: userModelTable.id })
      .from(userModelTable)
      .where(eq(userModelTable.id, modelId))
      .limit(1)
    if (!row) {
      throw DataApiErrorFactory.validation(
        { modelId: [`Model '${modelId}' is not registered in user_model`] },
        `Assistant modelId '${modelId}' is not registered — add the model first or pass null`
      )
    }
  }

  /**
   * Resolve the effective `modelId` for a create request.
   *
   * Three cases:
   *   1. Caller supplies a string → strict validation against `user_model`;
   *      a missing row raises `VALIDATION_ERROR` (caller error).
   *   2. Caller supplies `null` → respect the explicit "no default model"
   *      choice, no preference fallback.
   *   3. Caller omits the field (`undefined`) → fall back to the user's
   *      `chat.default_model_id` preference. A stale value (e.g. the model
   *      was deleted after the preference was set) silently degrades to
   *      `null` — the same spirit as the FK's `onDelete: 'set null'`,
   *      applied at the creation boundary rather than after the fact.
   *
   * v2 transition: this replaces the legacy pattern where the renderer
   * looked up Redux `state.llm.defaultModel` and pushed a UniqueModelId
   * that was not guaranteed to exist in `user_model`.
   */
  private async resolveCreateModelId(
    tx: Pick<DbType, 'select'>,
    dtoModelId: string | null | undefined
  ): Promise<string | null> {
    if (dtoModelId !== undefined) {
      if (dtoModelId) await this.assertModelExists(tx, dtoModelId)
      return dtoModelId
    }
    const preferred = application.get('PreferenceService').get('chat.default_model_id') ?? null
    if (!preferred) return null

    const [row] = await tx
      .select({ id: userModelTable.id })
      .from(userModelTable)
      .where(eq(userModelTable.id, preferred))
      .limit(1)
    if (!row) {
      logger.warn('chat.default_model_id is stale; creating assistant without a bound model', {
        preferred
      })
      return null
    }
    return preferred
  }

  /**
   * Batch-resolve `Model.name` for a set of unique model ids via `user_model`.
   *
   * Applies the same USAGE GUIDANCE principle as `getTagsByAssistantIds`:
   * owning services resolve their embed fields with a single round-trip.
   * Returns a Map keyed by UniqueModelId; missing ids map to absent entries
   * so callers can fall back to `null` without extra null-checks.
   */
  private async getModelNamesByUniqueIds(uniqueIds: (string | null | undefined)[]): Promise<Map<string, string>> {
    const result = new Map<string, string>()
    const ids = Array.from(new Set(uniqueIds.filter((id): id is string => typeof id === 'string' && id.length > 0)))
    if (ids.length === 0) return result

    const rows = await this.db
      .select({ id: userModelTable.id, name: userModelTable.name })
      .from(userModelTable)
      .where(inArray(userModelTable.id, ids))

    for (const row of rows) {
      if (row.name) result.set(row.id, row.name)
    }
    return result
  }

  /**
   * Batch-load tags for a set of assistants via inline JOIN of `entity_tag` + `tag`.
   *
   * Follows the TagService USAGE GUIDANCE: read paths in owning services should
   * fetch associated tags via a single JOIN, not via per-entity TagService calls.
   *
   * **Ordering contract**: `(assistantId, tag.name)` — grouped per assistant,
   * alphabetical within each group. Matches `TagService.getTagsByEntity` so a
   * single assistant's tags are identically ordered regardless of whether they
   * came from `GET /assistants/:id` (this path) or `GET /tags/entities/...`.
   *
   * An optional `tx` parameter lets callers reuse an in-flight transaction so
   * create / update can read back the freshly-written bindings atomically with
   * the rest of their write.
   */
  private async getTagsByAssistantIds(
    assistantIds: string[],
    tx: Pick<DbType, 'select'> = this.db
  ): Promise<Map<string, Tag[]>> {
    const tagMap = new Map<string, Tag[]>()

    if (assistantIds.length === 0) {
      return tagMap
    }

    for (const id of assistantIds) {
      tagMap.set(id, [])
    }

    const rows = await tx
      .select({
        assistantId: entityTagTable.entityId,
        tagId: tagTable.id,
        tagName: tagTable.name,
        tagColor: tagTable.color,
        tagCreatedAt: tagTable.createdAt,
        tagUpdatedAt: tagTable.updatedAt
      })
      .from(entityTagTable)
      .innerJoin(tagTable, eq(entityTagTable.tagId, tagTable.id))
      .where(and(eq(entityTagTable.entityType, 'assistant'), inArray(entityTagTable.entityId, assistantIds)))
      .orderBy(asc(entityTagTable.entityId), asc(tagTable.name))

    for (const row of rows) {
      tagMap.get(row.assistantId)?.push({
        id: row.tagId,
        name: row.tagName,
        color: row.tagColor ?? null,
        createdAt: timestampToISO(row.tagCreatedAt),
        updatedAt: timestampToISO(row.tagUpdatedAt)
      })
    }

    return tagMap
  }

  private async getRelationIdsByAssistantIds(assistantIds: string[]): Promise<Map<string, AssistantRelationIds>> {
    const relationMap = new Map<string, AssistantRelationIds>()

    if (assistantIds.length === 0) {
      return relationMap
    }

    for (const assistantId of assistantIds) {
      relationMap.set(assistantId, createEmptyRelations())
    }

    const [mcpServerRows, knowledgeBaseRows] = await Promise.all([
      this.db
        .select({ assistantId: assistantMcpServerTable.assistantId, mcpServerId: assistantMcpServerTable.mcpServerId })
        .from(assistantMcpServerTable)
        .where(inArray(assistantMcpServerTable.assistantId, assistantIds))
        .orderBy(asc(assistantMcpServerTable.assistantId), asc(assistantMcpServerTable.createdAt)),
      this.db
        .select({
          assistantId: assistantKnowledgeBaseTable.assistantId,
          knowledgeBaseId: assistantKnowledgeBaseTable.knowledgeBaseId
        })
        .from(assistantKnowledgeBaseTable)
        .where(inArray(assistantKnowledgeBaseTable.assistantId, assistantIds))
        .orderBy(asc(assistantKnowledgeBaseTable.assistantId), asc(assistantKnowledgeBaseTable.createdAt))
    ])

    for (const row of mcpServerRows) {
      relationMap.get(row.assistantId)?.mcpServerIds.push(row.mcpServerId)
    }
    for (const row of knowledgeBaseRows) {
      relationMap.get(row.assistantId)?.knowledgeBaseIds.push(row.knowledgeBaseId)
    }

    return relationMap
  }

  /**
   * Get an assistant by ID.
   * @param options.includeDeleted - If true, also returns soft-deleted assistants (for historical display)
   */
  async getById(id: string, options?: { includeDeleted?: boolean }): Promise<Assistant> {
    const conditions = [eq(assistantTable.id, id)]
    if (!options?.includeDeleted) {
      conditions.push(isNull(assistantTable.deletedAt))
    }
    const [row] = await this.db
      .select()
      .from(assistantTable)
      .where(and(...conditions))
      .limit(1)
    if (!row) {
      throw DataApiErrorFactory.notFound('Assistant', id)
    }
    const [relations, tags, modelNames] = await Promise.all([
      this.getRelationIdsByAssistantIds([id]),
      this.getTagsByAssistantIds([id]),
      this.getModelNamesByUniqueIds([row.modelId])
    ])
    return rowToAssistant(row, relations.get(id), tags.get(id), pickModelName(row.modelId, modelNames))
  }

  /**
   * List assistants with optional filters.
   *
   * Filter composition:
   * - `id` / `search` / `tagIds` AND together (tag-scoped text search).
   * - `search` runs LIKE %kw% against `name` OR `description` (case-insensitive
   *   for ASCII, byte-wise substring for CJK — both expected by the UI).
   *   SQLite LIKE wildcards (`%`/`_`) in the raw input are escaped.
   * - `tagIds` uses a correlated subquery on `entity_tag` for union semantics:
   *   an assistant is kept if it has ANY of the given tag ids. Kept in the
   *   WHERE clause (not a JOIN) so pagination's `count(*)` stays correct
   *   without `DISTINCT` gymnastics.
   *
   * `page` and `limit` are filled by the schema default — no runtime fallback.
   */
  async list(query: ListAssistantsQuery): Promise<{ items: Assistant[]; total: number; page: number }> {
    const { page, limit } = query
    const offset = (page - 1) * limit

    const conditions: SQL[] = [isNull(assistantTable.deletedAt)]
    if (query.id !== undefined) {
      conditions.push(eq(assistantTable.id, query.id))
    }
    if (query.search) {
      const pattern = `%${query.search.replace(/[\\%_]/g, '\\$&')}%`
      // `\` escape clause so literal %/_ typed by the user don't act as wildcards.
      const nameMatch = sql`${assistantTable.name} LIKE ${pattern} ESCAPE '\\'`
      const descMatch = sql`${assistantTable.description} LIKE ${pattern} ESCAPE '\\'`
      const searchClause = or(nameMatch, descMatch)
      if (searchClause) conditions.push(searchClause)
    }
    if (query.tagIds && query.tagIds.length > 0) {
      const tagIds = Array.from(new Set(query.tagIds))
      conditions.push(
        inArray(
          assistantTable.id,
          this.db
            .select({ entityId: entityTagTable.entityId })
            .from(entityTagTable)
            .where(and(eq(entityTagTable.entityType, 'assistant'), inArray(entityTagTable.tagId, tagIds)))
        )
      )
    }

    const whereClause = and(...conditions)

    const [rows, [{ count }]] = await Promise.all([
      this.db
        .select()
        .from(assistantTable)
        .where(whereClause)
        .orderBy(asc(assistantTable.createdAt))
        .limit(limit)
        .offset(offset),
      this.db.select({ count: sql<number>`count(*)` }).from(assistantTable).where(whereClause)
    ])

    const assistantIds = rows.map((row) => row.id)
    const [relations, tags, modelNames] = await Promise.all([
      this.getRelationIdsByAssistantIds(assistantIds),
      this.getTagsByAssistantIds(assistantIds),
      this.getModelNamesByUniqueIds(rows.map((row) => row.modelId))
    ])
    const items = rows.map((row) =>
      rowToAssistant(row, relations.get(row.id), tags.get(row.id), pickModelName(row.modelId, modelNames))
    )

    return {
      items,
      total: Number(count),
      page
    }
  }

  /**
   * Create a new assistant.
   *
   * `tagIds`, `mcpServerIds`, `knowledgeBaseIds` all land inside the same
   * transaction as the insert — one failed binding rolls the assistant row
   * back so callers never observe a half-written record.
   */
  async create(dto: CreateAssistantDto): Promise<Assistant> {
    this.validateName(dto.name)

    const { row, tags } = await this.db.transaction(async (tx) => {
      // Resolve modelId: explicit values strictly validated; omission falls
      // back to `chat.default_model_id` preference (stale → null).
      const modelId = await this.resolveCreateModelId(tx, dto.modelId)

      // Split relation/tag fields from columns. Service owns emoji/settings
      // defaults; prompt/description stay omitted when undefined so DB DEFAULTs apply.
      const { mcpServerIds, knowledgeBaseIds, tagIds, ...columnDto } = dto
      const insertValues: typeof assistantTable.$inferInsert = {
        ...columnDto,
        modelId,
        emoji: dto.emoji ?? '🌟',
        settings: dto.settings ?? DEFAULT_ASSISTANT_SETTINGS
      }

      const [inserted] = await tx.insert(assistantTable).values(insertValues).returning()

      await this.syncRelations(tx, inserted.id, { mcpServerIds, knowledgeBaseIds })

      if (tagIds !== undefined) {
        await tagService.syncEntityTagsWithin(tx, 'assistant', inserted.id, tagIds)
      }

      // Re-read the bound tags inside the tx so the response reflects the
      // freshly-written bindings (name/color/timestamps all resolved in one trip).
      const tagMap = await this.getTagsByAssistantIds([inserted.id], tx)
      return { row: inserted, tags: tagMap.get(inserted.id) ?? [] }
    })

    logger.info('Created assistant', { id: row.id, name: row.name })

    // Resolve model name for the caller — avoids the client having to refetch
    // just to get a human-readable label after create.
    const modelNames = await this.getModelNamesByUniqueIds([row.modelId])
    return rowToAssistant(
      row,
      {
        mcpServerIds: dto.mcpServerIds ?? [],
        knowledgeBaseIds: dto.knowledgeBaseIds ?? []
      },
      tags,
      pickModelName(row.modelId, modelNames)
    )
  }

  /**
   * Update an existing assistant.
   *
   * Column write, junction-table syncs (mcpServer / knowledgeBase / tag) all
   * run under one transaction so save-time failures cannot leave the entity
   * desynced from its bindings.
   *
   * **Soft-delete TOCTOU guard**: every write inside the transaction is gated
   * by `isNull(deletedAt)`. If another window soft-deleted the assistant
   * between the entry `getById` and the transaction, we throw `NOT_FOUND` and
   * roll back — the client can never observe a "saved successfully" response
   * on an already-deleted row.
   */
  async update(id: string, dto: UpdateAssistantDto): Promise<Assistant> {
    const current = await this.getById(id)

    if (dto.name !== undefined) {
      this.validateName(dto.name)
    }

    // Strip relation fields — these are synced to junction tables, not assistant columns
    const { mcpServerIds, knowledgeBaseIds, tagIds, ...columnFields } = dto
    const updates = Object.fromEntries(Object.entries(columnFields).filter(([, v]) => v !== undefined)) as Partial<
      typeof assistantTable.$inferInsert
    >
    const hasColumnUpdates = Object.keys(updates).length > 0
    const hasRelationUpdates = mcpServerIds !== undefined || knowledgeBaseIds !== undefined
    const hasTagUpdate = tagIds !== undefined

    if (!hasColumnUpdates && !hasRelationUpdates && !hasTagUpdate) {
      return current
    }

    const nextRelations: AssistantRelationIds = {
      mcpServerIds: mcpServerIds ?? current.mcpServerIds,
      knowledgeBaseIds: knowledgeBaseIds ?? current.knowledgeBaseIds
    }

    const aliveFilter = and(eq(assistantTable.id, id), isNull(assistantTable.deletedAt))

    const { row, tags } = await this.db.transaction(async (tx) => {
      // Pre-validate the new FK target before any write — same reasoning as
      // in `create`. Only runs when caller actually sets a non-null modelId.
      if (dto.modelId) {
        await this.assertModelExists(tx, dto.modelId)
      }

      let next: AssistantRow
      if (hasColumnUpdates) {
        const [updated] = await tx.update(assistantTable).set(updates).where(aliveFilter).returning()
        if (!updated) {
          throw DataApiErrorFactory.notFound('Assistant', id)
        }
        next = updated
      } else {
        // Relation-only / tag-only edits still need the same liveness guard,
        // otherwise a concurrent soft-delete would let us write junction rows
        // against a deleted assistant.
        const [existing] = await tx.select().from(assistantTable).where(aliveFilter).limit(1)
        if (!existing) {
          throw DataApiErrorFactory.notFound('Assistant', id)
        }
        next = existing
      }

      await this.syncRelations(tx, id, { mcpServerIds, knowledgeBaseIds })

      if (hasTagUpdate) {
        await tagService.syncEntityTagsWithin(tx, 'assistant', id, tagIds)
      }

      // Re-read bound tags inside the tx when they were touched; otherwise
      // reuse the snapshot taken on entry (saves a query on column-only edits).
      const nextTags = hasTagUpdate ? ((await this.getTagsByAssistantIds([id], tx)).get(id) ?? []) : current.tags
      return { row: next, tags: nextTags }
    })

    logger.info('Updated assistant', { id, changes: Object.keys(dto) })

    // If modelId changed, re-resolve the display name; otherwise reuse
    // `current.modelName` to avoid an extra query.
    const modelIdChanged = dto.modelId !== undefined && dto.modelId !== current.modelId
    let nextModelName = current.modelName
    if (modelIdChanged) {
      const modelNames = await this.getModelNamesByUniqueIds([dto.modelId ?? null])
      nextModelName = pickModelName(dto.modelId ?? null, modelNames)
    }

    return rowToAssistant(row, nextRelations, tags, nextModelName)
  }

  /**
   * Soft-delete an assistant (sets deletedAt timestamp).
   * The row is preserved so topic.assistantId FK remains valid
   * and junction table data (mcpServers, knowledgeBases) is retained.
   * Tag bindings are intentionally removed during delete, so restoring a
   * soft-deleted assistant does not restore its previous tags.
   */
  async delete(id: string): Promise<void> {
    await this.getActiveRowById(id)

    await this.db.transaction(async (tx) => {
      await tx.update(assistantTable).set({ deletedAt: Date.now() }).where(eq(assistantTable.id, id))
      await tagService.purgeForEntity(tx, 'assistant', id)
      await pinService.purgeForEntity(tx, 'assistant', id)
    })

    logger.info('Soft-deleted assistant', { id })
  }

  /**
   * Sync junction table rows for an assistant.
   * If an array is provided, it replaces all existing rows (delete + insert).
   * If undefined, the existing rows are left unchanged.
   * Runs within the caller's transaction for atomicity.
   */
  private async syncRelations(
    tx: Pick<DbType, 'delete' | 'insert' | 'select'>,
    assistantId: string,
    dto: { mcpServerIds?: string[]; knowledgeBaseIds?: string[] }
  ): Promise<void> {
    if (dto.mcpServerIds !== undefined) {
      const existing = await tx
        .select({ mcpServerId: assistantMcpServerTable.mcpServerId })
        .from(assistantMcpServerTable)
        .where(eq(assistantMcpServerTable.assistantId, assistantId))
      const existingIds = new Set(existing.map((r) => r.mcpServerId))
      const desiredIds = new Set(dto.mcpServerIds)

      const removeIds = existing.filter((r) => !desiredIds.has(r.mcpServerId)).map((r) => r.mcpServerId)
      const toAdd = dto.mcpServerIds.filter((id) => !existingIds.has(id))

      if (removeIds.length > 0) {
        await tx
          .delete(assistantMcpServerTable)
          .where(
            and(
              eq(assistantMcpServerTable.assistantId, assistantId),
              inArray(assistantMcpServerTable.mcpServerId, removeIds)
            )
          )
      }
      if (toAdd.length > 0) {
        await tx.insert(assistantMcpServerTable).values(toAdd.map((mcpServerId) => ({ assistantId, mcpServerId })))
      }
    }

    if (dto.knowledgeBaseIds !== undefined) {
      const existing = await tx
        .select({ knowledgeBaseId: assistantKnowledgeBaseTable.knowledgeBaseId })
        .from(assistantKnowledgeBaseTable)
        .where(eq(assistantKnowledgeBaseTable.assistantId, assistantId))
      const existingIds = new Set(existing.map((r) => r.knowledgeBaseId))
      const desiredIds = new Set(dto.knowledgeBaseIds)

      const removeIds = existing.filter((r) => !desiredIds.has(r.knowledgeBaseId)).map((r) => r.knowledgeBaseId)
      const toAdd = dto.knowledgeBaseIds.filter((id) => !existingIds.has(id))

      if (removeIds.length > 0) {
        await tx
          .delete(assistantKnowledgeBaseTable)
          .where(
            and(
              eq(assistantKnowledgeBaseTable.assistantId, assistantId),
              inArray(assistantKnowledgeBaseTable.knowledgeBaseId, removeIds)
            )
          )
      }
      if (toAdd.length > 0) {
        await tx
          .insert(assistantKnowledgeBaseTable)
          .values(toAdd.map((knowledgeBaseId) => ({ assistantId, knowledgeBaseId })))
      }
    }
  }

  private validateName(name: string): void {
    if (!name?.trim()) {
      throw DataApiErrorFactory.validation({ name: ['Name is required'] })
    }
  }
}

export const assistantDataService = new AssistantDataService()
