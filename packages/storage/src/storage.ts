import { createHash } from "node:crypto";
import { Pool } from "pg";
import { createPool, withTransaction } from "./db.js";
import type {
  AnalysisRunInput,
  CandidateEdgeInput,
  CandidateListItem,
  CandidateRef,
  ChannelSignatureInput,
  ChangedPathInput,
  DuplicateSetEdge,
  DuplicateSetNode,
  InstallationUpsertInput,
  PullRequestChannelCounts,
  PullRequestDetailRow,
  PrFileInput,
  ProductionSignatureRow,
  PullRequestUpsertInput,
  RepoListItem,
  RepositoryUpsertInput,
  SymbolInput,
  TriageQueueResult,
  WebhookDeliveryInput,
} from "./types.js";

function encodeCursor(updatedAt: Date, prId: number): string {
  return Buffer.from(
    JSON.stringify({ updatedAt: updatedAt.toISOString(), prId }),
    "utf8",
  ).toString("base64url");
}

function decodeCursor(cursor: string): { updatedAt: Date; prId: number } {
  const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as {
    updatedAt: string;
    prId: number;
  };

  return {
    updatedAt: new Date(decoded.updatedAt),
    prId: decoded.prId,
  };
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((entry): entry is string => typeof entry === "string");
}

function toJsonbValue(value: unknown): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  return JSON.stringify(value);
}

function normalizeStringOrNumber(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return 0;
}

function normalizeStringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export class Storage {
  public readonly pool: Pool;

  constructor(pool?: Pool) {
    this.pool = pool ?? createPool();
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  static payloadSha256(payload: Buffer): string {
    return createHash("sha256").update(payload).digest("hex");
  }

  async recordWebhookDeliveryReceived(input: WebhookDeliveryInput): Promise<{
    inserted: boolean;
    existingStatus: string | null;
  }> {
    const result = await this.pool.query(
      `
      WITH inserted AS (
        INSERT INTO webhook_deliveries (
          delivery_id,
          repo_id,
          event_name,
          action,
          payload_sha256,
          status
        )
        VALUES ($1, $2, $3, $4, $5, 'RECEIVED')
        ON CONFLICT (delivery_id) DO NOTHING
        RETURNING status
      )
      SELECT
        EXISTS (SELECT 1 FROM inserted) AS inserted,
        (
          SELECT status::text FROM inserted
          UNION ALL
          SELECT status::text FROM webhook_deliveries WHERE delivery_id = $1
          LIMIT 1
        ) AS status
      `,
      [
        input.deliveryId,
        input.repoId,
        input.eventName,
        input.action,
        input.payloadSha256,
      ],
    );

    const row = result.rows[0] as { inserted: boolean; status: string | null };
    return {
      inserted: Boolean(row.inserted),
      existingStatus: row.status ?? null,
    };
  }

  async markWebhookDeliveryStatus(
    deliveryId: string,
    status: "RECEIVED" | "PROCESSED" | "SKIPPED" | "FAILED",
    error?: string,
  ): Promise<void> {
    await this.pool.query(
      `
      UPDATE webhook_deliveries
      SET
        status = $2,
        error = $3,
        processed_at = CASE
          WHEN $2 IN ('PROCESSED', 'SKIPPED', 'FAILED') THEN NOW()
          ELSE processed_at
        END
      WHERE delivery_id = $1
      `,
      [deliveryId, status, error ?? null],
    );
  }

  async upsertInstallation(input: InstallationUpsertInput): Promise<void> {
    await this.pool.query(
      `
      INSERT INTO github_installations (
        installation_id,
        account_login,
        account_type
      )
      VALUES ($1, $2, $3)
      ON CONFLICT (installation_id)
      DO UPDATE SET
        account_login = EXCLUDED.account_login,
        account_type = EXCLUDED.account_type,
        updated_at = NOW()
      `,
      [input.installationId, input.accountLogin, input.accountType],
    );
  }

  async upsertRepository(input: RepositoryUpsertInput): Promise<void> {
    await this.pool.query(
      `
      INSERT INTO repositories (
        repo_id,
        installation_id,
        owner,
        name,
        default_branch,
        is_active
      )
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (repo_id)
      DO UPDATE SET
        installation_id = EXCLUDED.installation_id,
        owner = EXCLUDED.owner,
        name = EXCLUDED.name,
        default_branch = EXCLUDED.default_branch,
        is_active = EXCLUDED.is_active,
        updated_at = NOW()
      `,
      [
        input.repoId,
        input.installationId,
        input.owner,
        input.name,
        input.defaultBranch,
        input.isActive ?? true,
      ],
    );
  }

  async getRepositoryById(repoId: number): Promise<{
    repoId: number;
    installationId: number;
    owner: string;
    name: string;
    defaultBranch: string;
  } | null> {
    const result = await this.pool.query(
      `
      SELECT
        repo_id,
        installation_id,
        owner,
        name,
        default_branch
      FROM repositories
      WHERE repo_id = $1
      `,
      [repoId],
    );

    if ((result.rowCount ?? 0) === 0) {
      return null;
    }

    const row = result.rows[0];
    return {
      repoId: Number(row.repo_id),
      installationId: Number(row.installation_id),
      owner: String(row.owner),
      name: String(row.name),
      defaultBranch: String(row.default_branch),
    };
  }

  async upsertPullRequest(input: PullRequestUpsertInput): Promise<void> {
    await this.pool.query(
      `
      INSERT INTO pull_requests (
        pr_id,
        repo_id,
        number,
        state,
        is_draft,
        title,
        body,
        author_login,
        url,
        base_ref,
        base_sha,
        head_ref,
        head_repo_full_name,
        head_sha,
        additions,
        deletions,
        changed_files,
        created_at,
        updated_at,
        closed_at,
        merged_at,
        last_ingested_delivery_id,
        analysis_status
      )
      VALUES (
        $1, $2, $3, $4::pr_state, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
        $15, $16, $17, $18, $19, $20, $21, $22, COALESCE($23::analysis_status, 'PENDING')
      )
      ON CONFLICT (pr_id)
      DO UPDATE SET
        repo_id = EXCLUDED.repo_id,
        number = EXCLUDED.number,
        state = EXCLUDED.state,
        is_draft = EXCLUDED.is_draft,
        title = EXCLUDED.title,
        body = EXCLUDED.body,
        author_login = EXCLUDED.author_login,
        url = EXCLUDED.url,
        base_ref = EXCLUDED.base_ref,
        base_sha = EXCLUDED.base_sha,
        head_ref = EXCLUDED.head_ref,
        head_repo_full_name = EXCLUDED.head_repo_full_name,
        head_sha = EXCLUDED.head_sha,
        additions = EXCLUDED.additions,
        deletions = EXCLUDED.deletions,
        changed_files = EXCLUDED.changed_files,
        created_at = EXCLUDED.created_at,
        updated_at = EXCLUDED.updated_at,
        closed_at = EXCLUDED.closed_at,
        merged_at = EXCLUDED.merged_at,
        last_ingested_delivery_id = EXCLUDED.last_ingested_delivery_id,
        analysis_status = EXCLUDED.analysis_status
      `,
      [
        input.prId,
        input.repoId,
        input.number,
        input.state,
        input.isDraft,
        input.title,
        input.body,
        input.authorLogin,
        input.url,
        input.baseRef,
        input.baseSha,
        input.headRef,
        input.headRepoFullName,
        input.headSha,
        input.additions,
        input.deletions,
        input.changedFiles,
        input.createdAt,
        input.updatedAt,
        input.closedAt,
        input.mergedAt,
        input.lastIngestedDeliveryId,
        input.analysisStatus ?? null,
      ],
    );
  }

  async replacePrFiles(prId: number, headSha: string, files: PrFileInput[]): Promise<void> {
    await withTransaction(this.pool, async (client) => {
      await client.query("DELETE FROM pr_files WHERE pr_id = $1 AND head_sha = $2", [prId, headSha]);

      for (const file of files) {
        await client.query(
          `
          INSERT INTO pr_files (
            repo_id,
            pr_id,
            head_sha,
            path,
            previous_path,
            status,
            additions,
            deletions,
            patch_truncated,
            channel,
            detected_language
          )
          VALUES (
            $1,
            $2,
            $3,
            $4,
            $5,
            $6::file_status,
            $7,
            $8,
            $9,
            $10::file_channel,
            $11
          )
          ON CONFLICT (pr_id, head_sha, path)
          DO UPDATE SET
            previous_path = EXCLUDED.previous_path,
            status = EXCLUDED.status,
            additions = EXCLUDED.additions,
            deletions = EXCLUDED.deletions,
            patch_truncated = EXCLUDED.patch_truncated,
            channel = EXCLUDED.channel,
            detected_language = EXCLUDED.detected_language,
            created_at = NOW()
          `,
          [
            file.repoId,
            file.prId,
            file.headSha,
            file.path,
            file.previousPath,
            file.status,
            file.additions,
            file.deletions,
            file.patchTruncated,
            file.channel,
            file.detectedLanguage,
          ],
        );
      }
    });
  }

  async upsertChannelSignature(input: ChannelSignatureInput): Promise<void> {
    await this.pool.query(
      `
      INSERT INTO pr_channel_signatures (
        pr_id,
        repo_id,
        head_sha,
        channel,
        signature_version,
        canonical_diff_hash,
        minhash,
        minhash_shingle_count,
        exports_json,
        symbols_json,
        imports_json,
        test_intent_json,
        doc_structure_json,
        size_metrics_json,
        errors_json
      )
      VALUES (
        $1,
        $2,
        $3,
        $4::file_channel,
        $5,
        $6,
        $7,
        $8,
        $9,
        $10,
        $11,
        $12,
        $13,
        $14,
        $15
      )
      ON CONFLICT (pr_id, head_sha, channel, signature_version)
      DO UPDATE SET
        canonical_diff_hash = EXCLUDED.canonical_diff_hash,
        minhash = EXCLUDED.minhash,
        minhash_shingle_count = EXCLUDED.minhash_shingle_count,
        exports_json = EXCLUDED.exports_json,
        symbols_json = EXCLUDED.symbols_json,
        imports_json = EXCLUDED.imports_json,
        test_intent_json = EXCLUDED.test_intent_json,
        doc_structure_json = EXCLUDED.doc_structure_json,
        size_metrics_json = EXCLUDED.size_metrics_json,
        errors_json = EXCLUDED.errors_json,
        computed_at = NOW()
      `,
      [
        input.prId,
        input.repoId,
        input.headSha,
        input.channel,
        input.signatureVersion,
        input.canonicalDiffHash ?? null,
        input.minhash ?? null,
        input.minhashShingleCount ?? 0,
        toJsonbValue(input.exportsJson),
        toJsonbValue(input.symbolsJson),
        toJsonbValue(input.importsJson),
        toJsonbValue(input.testIntentJson),
        toJsonbValue(input.docStructureJson),
        toJsonbValue(input.sizeMetricsJson),
        toJsonbValue(input.errorsJson),
      ],
    );
  }

  async replaceChangedPaths(
    prId: number,
    headSha: string,
    paths: ChangedPathInput[],
  ): Promise<void> {
    await withTransaction(this.pool, async (client) => {
      await client.query("DELETE FROM pr_changed_paths WHERE pr_id = $1 AND head_sha = $2", [
        prId,
        headSha,
      ]);

      for (const entry of paths) {
        await client.query(
          `
          INSERT INTO pr_changed_paths (
            repo_id,
            pr_id,
            head_sha,
            channel,
            path,
            dir_prefix_1,
            dir_prefix_2,
            dir_prefix_3
          )
          VALUES (
            $1,
            $2,
            $3,
            $4::file_channel,
            $5,
            $6,
            $7,
            $8
          )
          ON CONFLICT (pr_id, head_sha, channel, path)
          DO UPDATE SET
            dir_prefix_1 = EXCLUDED.dir_prefix_1,
            dir_prefix_2 = EXCLUDED.dir_prefix_2,
            dir_prefix_3 = EXCLUDED.dir_prefix_3,
            created_at = NOW()
          `,
          [
            entry.repoId,
            entry.prId,
            entry.headSha,
            entry.channel,
            entry.path,
            entry.dirPrefix1,
            entry.dirPrefix2,
            entry.dirPrefix3,
          ],
        );
      }
    });
  }

  async replaceSymbols(prId: number, headSha: string, symbols: SymbolInput[]): Promise<void> {
    await withTransaction(this.pool, async (client) => {
      await client.query("DELETE FROM pr_symbols WHERE pr_id = $1 AND head_sha = $2", [prId, headSha]);

      for (const symbol of symbols) {
        await client.query(
          `
          INSERT INTO pr_symbols (
            repo_id,
            pr_id,
            head_sha,
            symbol,
            kind
          )
          VALUES ($1, $2, $3, $4, $5)
          ON CONFLICT (pr_id, head_sha, kind, symbol)
          DO UPDATE SET created_at = NOW()
          `,
          [symbol.repoId, symbol.prId, symbol.headSha, symbol.symbol, symbol.kind],
        );
      }
    });
  }

  async insertAnalysisRun(input: AnalysisRunInput): Promise<void> {
    await this.pool.query(
      `
      INSERT INTO pr_analysis_runs (
        analysis_run_id,
        repo_id,
        pr_id,
        head_sha,
        signature_version,
        algorithm_version,
        config_version,
        status,
        started_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8::analysis_status, $9)
      `,
      [
        input.analysisRunId,
        input.repoId,
        input.prId,
        input.headSha,
        input.signatureVersion,
        input.algorithmVersion,
        input.configVersion,
        input.status,
        input.startedAt,
      ],
    );
  }

  async finishAnalysisRun(
    analysisRunId: string,
    status: "DONE" | "DEGRADED" | "FAILED",
    error?: string,
    degradedReasons?: unknown,
  ): Promise<void> {
    await this.pool.query(
      `
      UPDATE pr_analysis_runs
      SET
        status = $2::analysis_status,
        finished_at = NOW(),
        error = $3,
        degraded_reasons = $4::jsonb
      WHERE analysis_run_id = $1
      `,
      [analysisRunId, status, error ?? null, toJsonbValue(degradedReasons)],
    );
  }

  async insertCandidateEdges(edges: CandidateEdgeInput[]): Promise<void> {
    for (const edge of edges) {
      await this.pool.query(
        `
        INSERT INTO pr_candidate_edges (
          analysis_run_id,
          repo_id,
          pr_id_a,
          head_sha_a,
          pr_id_b,
          head_sha_b,
          rank,
          category,
          final_score,
          scores_json,
          evidence_json
        )
        VALUES (
          $1,
          $2,
          $3,
          $4,
          $5,
          $6,
          $7,
          $8::triage_category,
          $9,
          $10::jsonb,
          $11::jsonb
        )
        ON CONFLICT (analysis_run_id, pr_id_b, head_sha_b)
        DO UPDATE SET
          rank = EXCLUDED.rank,
          category = EXCLUDED.category,
          final_score = EXCLUDED.final_score,
          scores_json = EXCLUDED.scores_json,
          evidence_json = EXCLUDED.evidence_json,
          created_at = NOW()
        `,
        [
          edge.analysisRunId,
          edge.repoId,
          edge.prIdA,
          edge.headShaA,
          edge.prIdB,
          edge.headShaB,
          edge.rank,
          edge.category,
          edge.finalScore,
          toJsonbValue(edge.scoresJson),
          toJsonbValue(edge.evidenceJson),
        ],
      );
    }
  }

  async updatePullRequestAnalysisStatus(
    prId: number,
    updates: {
      analysisStatus: "PENDING" | "RUNNING" | "DONE" | "DEGRADED" | "FAILED";
      analysisError?: string | null;
      lastAnalyzedHeadSha?: string;
    },
  ): Promise<void> {
    await this.pool.query(
      `
      UPDATE pull_requests
      SET
        analysis_status = $2::analysis_status,
        analysis_error = $3,
        last_analyzed_head_sha = COALESCE($4, last_analyzed_head_sha),
        last_analyzed_at = CASE WHEN $4 IS NULL THEN last_analyzed_at ELSE NOW() END
      WHERE pr_id = $1
      `,
      [prId, updates.analysisStatus, updates.analysisError ?? null, updates.lastAnalyzedHeadSha ?? null],
    );
  }

  async findCandidatesByCanonicalDiffHash(
    repoId: number,
    canonicalDiffHash: string,
    signatureVersion: number,
    excludePrId: number,
    limit: number,
  ): Promise<CandidateRef[]> {
    const result = await this.pool.query(
      `
      SELECT
        s.pr_id,
        s.head_sha
      FROM pr_channel_signatures s
      JOIN pull_requests pr
        ON pr.pr_id = s.pr_id
       AND pr.repo_id = s.repo_id
       AND pr.last_analyzed_head_sha = s.head_sha
      WHERE s.repo_id = $1
        AND s.channel = 'PRODUCTION'
        AND s.signature_version = $2
        AND s.canonical_diff_hash = $3
        AND s.pr_id <> $4
        AND pr.state = 'OPEN'
      LIMIT $5
      `,
      [repoId, signatureVersion, canonicalDiffHash, excludePrId, limit],
    );

    return result.rows.map((row) => ({
      prId: Number(row.pr_id),
      headSha: String(row.head_sha),
    }));
  }

  async findCandidatesByPaths(
    repoId: number,
    productionPaths: string[],
    excludePrId: number,
    limit: number,
  ): Promise<CandidateRef[]> {
    if (productionPaths.length === 0) {
      return [];
    }

    const result = await this.pool.query(
      `
      SELECT DISTINCT
        pr.pr_id,
        pr.last_analyzed_head_sha AS head_sha
      FROM pull_requests pr
      JOIN pr_changed_paths p
        ON p.pr_id = pr.pr_id
       AND p.repo_id = pr.repo_id
       AND p.head_sha = pr.last_analyzed_head_sha
      WHERE pr.repo_id = $1
        AND p.channel = 'PRODUCTION'
        AND p.path = ANY($2::text[])
        AND pr.pr_id <> $3
        AND pr.state = 'OPEN'
        AND pr.last_analyzed_head_sha IS NOT NULL
      LIMIT $4
      `,
      [repoId, productionPaths, excludePrId, limit],
    );

    return result.rows.map((row) => ({
      prId: Number(row.pr_id),
      headSha: String(row.head_sha),
    }));
  }

  async findCandidatesBySymbols(
    repoId: number,
    symbols: string[],
    kinds: Array<"decl" | "export" | "import">,
    excludePrId: number,
    limit: number,
  ): Promise<CandidateRef[]> {
    if (symbols.length === 0 || kinds.length === 0) {
      return [];
    }

    const result = await this.pool.query(
      `
      SELECT DISTINCT
        pr.pr_id,
        pr.last_analyzed_head_sha AS head_sha
      FROM pull_requests pr
      JOIN pr_symbols s
        ON s.pr_id = pr.pr_id
       AND s.repo_id = pr.repo_id
       AND s.head_sha = pr.last_analyzed_head_sha
      WHERE pr.repo_id = $1
        AND s.symbol = ANY($2::text[])
        AND s.kind = ANY($3::text[])
        AND pr.pr_id <> $4
        AND pr.state = 'OPEN'
        AND pr.last_analyzed_head_sha IS NOT NULL
      LIMIT $5
      `,
      [repoId, symbols, kinds, excludePrId, limit],
    );

    return result.rows.map((row) => ({
      prId: Number(row.pr_id),
      headSha: String(row.head_sha),
    }));
  }

  async getCurrentHeadsForPrIds(
    repoId: number,
    prIds: number[],
    excludePrId: number,
    limit: number,
  ): Promise<CandidateRef[]> {
    if (prIds.length === 0) {
      return [];
    }

    const result = await this.pool.query(
      `
      SELECT
        pr_id,
        last_analyzed_head_sha AS head_sha
      FROM pull_requests
      WHERE repo_id = $1
        AND pr_id = ANY($2::bigint[])
        AND pr_id <> $3
        AND state = 'OPEN'
        AND last_analyzed_head_sha IS NOT NULL
      LIMIT $4
      `,
      [repoId, prIds, excludePrId, limit],
    );

    return result.rows.map((row) => ({
      prId: Number(row.pr_id),
      headSha: String(row.head_sha),
    }));
  }

  async getProductionSignature(
    repoId: number,
    prId: number,
    headSha: string,
    signatureVersion: number,
  ): Promise<ProductionSignatureRow | null> {
    const result = await this.pool.query(
      `
      SELECT
        pr_id,
        head_sha,
        canonical_diff_hash,
        minhash,
        minhash_shingle_count,
        exports_json,
        symbols_json,
        imports_json
      FROM pr_channel_signatures
      WHERE repo_id = $1
        AND pr_id = $2
        AND head_sha = $3
        AND channel = 'PRODUCTION'
        AND signature_version = $4
      `,
      [repoId, prId, headSha, signatureVersion],
    );

    if ((result.rowCount ?? 0) === 0) {
      return null;
    }

    const row = result.rows[0];

    const testsSignature = await this.getChannelSignatureJson(
      repoId,
      prId,
      headSha,
      "TESTS",
      signatureVersion,
    );
    const docsSignature = await this.getChannelSignatureJson(
      repoId,
      prId,
      headSha,
      "DOCS",
      signatureVersion,
    );

    return {
      prId: Number(row.pr_id),
      headSha: String(row.head_sha),
      canonicalDiffHash: row.canonical_diff_hash ? String(row.canonical_diff_hash) : null,
      minhash: (row.minhash as Buffer | null) ?? null,
      minhashShingleCount: Number(row.minhash_shingle_count ?? 0),
      exportsJson: normalizeStringArray(row.exports_json),
      symbolsJson: normalizeStringArray(row.symbols_json),
      importsJson: normalizeStringArray(row.imports_json),
      testIntentJson: testsSignature?.testIntent ?? null,
      docStructureJson: docsSignature?.docsStructure ?? null,
    };
  }

  private async getChannelSignatureJson(
    repoId: number,
    prId: number,
    headSha: string,
    channel: "TESTS" | "DOCS",
    signatureVersion: number,
  ): Promise<{
    testIntent: {
      suiteNames: string[];
      testNames: string[];
      matchers: string[];
      importsUnderTest: string[];
    } | null;
    docsStructure: {
      headings: string[];
      codeFences: string[];
      references: string[];
    } | null;
  } | null> {
    const result = await this.pool.query(
      `
      SELECT test_intent_json, doc_structure_json
      FROM pr_channel_signatures
      WHERE repo_id = $1
        AND pr_id = $2
        AND head_sha = $3
        AND channel = $4::file_channel
        AND signature_version = $5
      `,
      [repoId, prId, headSha, channel, signatureVersion],
    );

    if ((result.rowCount ?? 0) === 0) {
      return null;
    }

    const row = result.rows[0];
    const rawTest = (row.test_intent_json ?? null) as
      | {
          suiteNames?: string[];
          testNames?: string[];
          matchers?: string[];
          importsUnderTest?: string[];
        }
      | null;
    const rawDocs = (row.doc_structure_json ?? null) as
      | {
          headings?: string[];
          codeFences?: string[];
          references?: string[];
        }
      | null;

    return {
      testIntent: rawTest
        ? {
            suiteNames: normalizeStringArray(rawTest.suiteNames),
            testNames: normalizeStringArray(rawTest.testNames),
            matchers: normalizeStringArray(rawTest.matchers),
            importsUnderTest: normalizeStringArray(rawTest.importsUnderTest),
          }
        : null,
      docsStructure: rawDocs
        ? {
            headings: normalizeStringArray(rawDocs.headings),
            codeFences: normalizeStringArray(rawDocs.codeFences),
            references: normalizeStringArray(rawDocs.references),
          }
        : null,
    };
  }

  async getPrNumberMap(repoId: number, prIds: number[]): Promise<Map<number, number>> {
    if (prIds.length === 0) {
      return new Map();
    }

    const result = await this.pool.query(
      `
      SELECT pr_id, number
      FROM pull_requests
      WHERE repo_id = $1
        AND pr_id = ANY($2::bigint[])
      `,
      [repoId, prIds],
    );

    const out = new Map<number, number>();
    for (const row of result.rows) {
      out.set(Number(row.pr_id), Number(row.number));
    }
    return out;
  }

  async getPathsForPrHead(
    repoId: number,
    prId: number,
    headSha: string,
    channel: "PRODUCTION" | "TESTS" | "DOCS" | "META",
  ): Promise<string[]> {
    const result = await this.pool.query(
      `
      SELECT path
      FROM pr_changed_paths
      WHERE repo_id = $1
        AND pr_id = $2
        AND head_sha = $3
        AND channel = $4::file_channel
      ORDER BY path ASC
      `,
      [repoId, prId, headSha, channel],
    );

    return result.rows.map((row) => String(row.path));
  }

  async listTriageQueue(params: {
    repoId: number;
    state: "OPEN" | "CLOSED" | "MERGED";
    needsReview: boolean;
    limit: number;
    cursor?: string;
    reviewThreshold: number;
    orderBy: "LAST_ANALYZED_AT" | "UPDATED_AT";
  }): Promise<TriageQueueResult> {
    const { repoId, state, needsReview, limit, cursor, reviewThreshold, orderBy } = params;
    const sortExpr =
      orderBy === "UPDATED_AT" ? "pr.updated_at" : "COALESCE(pr.last_analyzed_at, pr.updated_at)";

    const queryValues: Array<number | string | Date> = [repoId, state, reviewThreshold, limit + 1];

    let cursorClause = "";
    if (cursor) {
      const decoded = decodeCursor(cursor);
      queryValues.push(decoded.updatedAt, decoded.prId);
      cursorClause = `
        AND (${sortExpr}, pr.pr_id) < ($5::timestamptz, $6::bigint)
      `;
    }

    const needsReviewClause = needsReview
      ? "AND top.final_score IS NOT NULL AND top.final_score >= $3"
      : "";

    const result = await this.pool.query(
      `
      SELECT
        pr.repo_id,
        pr.number,
        pr.pr_id,
        pr.head_sha,
        pr.url AS pr_url,
        pr.title,
        pr.author_login,
        pr.state,
        pr.updated_at,
        pr.last_analyzed_at,
        pr.analysis_status,
        run.analysis_run_id,
        top.category AS top_category,
        top.pr_id_b AS candidate_pr_id,
        candidate.number AS candidate_pr_number,
        candidate.url AS candidate_pr_url,
        top.final_score,
        ${sortExpr} AS sort_ts
      FROM pull_requests pr
      LEFT JOIN LATERAL (
        SELECT analysis_run_id
        FROM pr_analysis_runs
        WHERE repo_id = pr.repo_id
          AND pr_id = pr.pr_id
          AND head_sha = pr.last_analyzed_head_sha
        ORDER BY started_at DESC
        LIMIT 1
      ) run ON TRUE
      LEFT JOIN LATERAL (
        SELECT
          e.category,
          e.pr_id_b,
          e.final_score
        FROM pr_analysis_runs r
        JOIN pr_candidate_edges e ON e.analysis_run_id = r.analysis_run_id
        WHERE r.repo_id = pr.repo_id
          AND r.pr_id = pr.pr_id
          AND r.head_sha = pr.last_analyzed_head_sha
        ORDER BY r.started_at DESC, e.rank ASC
        LIMIT 1
      ) top ON TRUE
      LEFT JOIN pull_requests candidate
        ON candidate.pr_id = top.pr_id_b
      WHERE pr.repo_id = $1
        AND pr.state = $2::pr_state
        ${needsReviewClause}
        ${cursorClause}
      ORDER BY ${sortExpr} DESC NULLS LAST, pr.pr_id DESC
      LIMIT $4
      `,
      queryValues,
    );

    const rows = result.rows;
    const hasMore = rows.length > limit;
    const selectedRows = hasMore ? rows.slice(0, limit) : rows;

    const mapped = selectedRows.map((row) => {
      const score = row.final_score == null ? null : Number(row.final_score);
      const sortTs = new Date(row.sort_ts);

      return {
        item: {
          repoId: Number(row.repo_id),
          prNumber: Number(row.number),
          prId: Number(row.pr_id),
          headSha: String(row.head_sha),
          prUrl: String(row.pr_url),
          title: String(row.title),
          authorLogin: row.author_login ? String(row.author_login) : null,
          state: String(row.state) as "OPEN" | "CLOSED" | "MERGED",
          updatedAt: new Date(row.updated_at),
          lastAnalyzedAt: row.last_analyzed_at ? new Date(row.last_analyzed_at) : null,
          analysisStatus: String(row.analysis_status) as
            | "PENDING"
            | "RUNNING"
            | "DONE"
            | "DEGRADED"
            | "FAILED",
          analysisRunId: row.analysis_run_id ? String(row.analysis_run_id) : null,
          topSuggestion:
            row.top_category &&
            row.candidate_pr_id &&
            row.candidate_pr_number &&
            row.candidate_pr_url &&
            score !== null
              ? {
                  category: String(row.top_category) as
                    | "SAME_CHANGE"
                    | "SAME_FEATURE"
                    | "COMPETING_IMPLEMENTATION"
                    | "RELATED"
                    | "NOT_RELATED"
                    | "UNCERTAIN",
                  candidatePrNumber: Number(row.candidate_pr_number),
                  candidatePrUrl: String(row.candidate_pr_url),
                  score,
                }
              : null,
          needsReview: score !== null && score >= reviewThreshold,
        },
        sortTs,
      };
    });

    const last = mapped.at(-1);
    return {
      items: mapped.map((entry) => entry.item),
      nextCursor: hasMore && last ? encodeCursor(last.sortTs, last.item.prId) : null,
    };
  }

  async listRepositories(): Promise<RepoListItem[]> {
    const result = await this.pool.query(
      `
      SELECT
        repo_id,
        owner,
        name,
        default_branch,
        is_active,
        installation_id
      FROM repositories
      ORDER BY owner ASC, name ASC
      `,
    );

    return result.rows.map((row) => ({
      repoId: Number(row.repo_id),
      owner: String(row.owner),
      name: String(row.name),
      defaultBranch: String(row.default_branch),
      isActive: Boolean(row.is_active),
      installationId: Number(row.installation_id),
    }));
  }

  async getPullRequestByNumber(repoId: number, prNumber: number): Promise<PullRequestDetailRow | null> {
    const result = await this.pool.query(
      `
      SELECT
        pr.repo_id,
        pr.pr_id,
        pr.number,
        pr.state,
        pr.is_draft,
        pr.title,
        pr.body,
        pr.author_login,
        pr.url,
        pr.base_ref,
        pr.base_sha,
        pr.head_ref,
        pr.head_sha,
        pr.created_at,
        pr.updated_at,
        pr.closed_at,
        pr.merged_at,
        pr.additions,
        pr.deletions,
        pr.changed_files,
        pr.analysis_status,
        pr.analysis_error,
        pr.last_analyzed_head_sha,
        pr.last_analyzed_at,
        run.analysis_run_id,
        run.signature_version,
        run.algorithm_version,
        run.config_version,
        run.degraded_reasons,
        run.finished_at AS analysis_finished_at
      FROM pull_requests pr
      LEFT JOIN LATERAL (
        SELECT
          analysis_run_id,
          signature_version,
          algorithm_version,
          config_version,
          degraded_reasons,
          finished_at
        FROM pr_analysis_runs
        WHERE repo_id = pr.repo_id
          AND pr_id = pr.pr_id
          AND head_sha = pr.last_analyzed_head_sha
        ORDER BY started_at DESC
        LIMIT 1
      ) run ON TRUE
      WHERE pr.repo_id = $1
        AND pr.number = $2
      LIMIT 1
      `,
      [repoId, prNumber],
    );

    if ((result.rowCount ?? 0) === 0) {
      return null;
    }

    const row = result.rows[0];
    return {
      repoId: Number(row.repo_id),
      prId: Number(row.pr_id),
      prNumber: Number(row.number),
      state: String(row.state) as "OPEN" | "CLOSED" | "MERGED",
      isDraft: Boolean(row.is_draft),
      title: String(row.title),
      body: row.body ? String(row.body) : null,
      authorLogin: row.author_login ? String(row.author_login) : null,
      url: String(row.url),
      baseRef: String(row.base_ref),
      baseSha: String(row.base_sha),
      headRef: String(row.head_ref),
      headSha: String(row.head_sha),
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
      closedAt: row.closed_at ? new Date(row.closed_at) : null,
      mergedAt: row.merged_at ? new Date(row.merged_at) : null,
      additions: Number(row.additions),
      deletions: Number(row.deletions),
      changedFiles: Number(row.changed_files),
      analysisStatus: String(row.analysis_status) as
        | "PENDING"
        | "RUNNING"
        | "DONE"
        | "DEGRADED"
        | "FAILED",
      analysisError: normalizeStringOrNull(row.analysis_error),
      lastAnalyzedHeadSha: normalizeStringOrNull(row.last_analyzed_head_sha),
      lastAnalyzedAt: row.last_analyzed_at ? new Date(row.last_analyzed_at) : null,
      analysisRunId: normalizeStringOrNull(row.analysis_run_id),
      signatureVersion:
        row.signature_version == null ? null : Number(row.signature_version),
      algorithmVersion:
        row.algorithm_version == null ? null : Number(row.algorithm_version),
      configVersion: row.config_version == null ? null : Number(row.config_version),
      degradedReasons: row.degraded_reasons ?? null,
      analysisFinishedAt: row.analysis_finished_at ? new Date(row.analysis_finished_at) : null,
    };
  }

  async getPullRequestChannelCounts(prId: number, headSha: string): Promise<PullRequestChannelCounts> {
    const result = await this.pool.query(
      `
      SELECT channel, COUNT(*)::int AS count
      FROM pr_files
      WHERE pr_id = $1
        AND head_sha = $2
      GROUP BY channel
      `,
      [prId, headSha],
    );

    let productionFiles = 0;
    let testFiles = 0;
    let docFiles = 0;
    let metaFiles = 0;

    for (const row of result.rows) {
      const count = Number(row.count ?? 0);
      const channel = String(row.channel);
      if (channel === "PRODUCTION") {
        productionFiles = count;
      } else if (channel === "TESTS") {
        testFiles = count;
      } else if (channel === "DOCS") {
        docFiles = count;
      } else if (channel === "META") {
        metaFiles = count;
      }
    }

    return {
      productionFiles,
      testFiles,
      docFiles,
      metaFiles,
    };
  }

  async getLatestAnalysisRunId(
    repoId: number,
    prId: number,
    headSha: string,
  ): Promise<string | null> {
    const result = await this.pool.query(
      `
      SELECT analysis_run_id
      FROM pr_analysis_runs
      WHERE repo_id = $1
        AND pr_id = $2
        AND head_sha = $3
      ORDER BY started_at DESC
      LIMIT 1
      `,
      [repoId, prId, headSha],
    );

    if ((result.rowCount ?? 0) === 0) {
      return null;
    }

    return String(result.rows[0].analysis_run_id);
  }

  async getCandidatesForAnalysisRun(
    analysisRunId: string,
    limit: number,
    minScore?: number,
  ): Promise<CandidateListItem[]> {
    const queryValues: Array<string | number> = [analysisRunId];
    let minScoreClause = "";
    let limitIndex = 2;

    if (typeof minScore === "number" && Number.isFinite(minScore)) {
      queryValues.push(minScore);
      minScoreClause = "AND e.final_score >= $2";
      limitIndex = 3;
    }

    queryValues.push(limit);

    const result = await this.pool.query(
      `
      SELECT
        e.analysis_run_id,
        src.number AS pr_number,
        e.head_sha_a AS head_sha,
        e.rank,
        e.category,
        e.final_score,
        e.scores_json,
        e.evidence_json,
        e.pr_id_b AS candidate_pr_id,
        e.head_sha_b AS candidate_head_sha,
        candidate.number AS candidate_pr_number,
        candidate.url AS candidate_pr_url
      FROM pr_candidate_edges e
      JOIN pull_requests src
        ON src.pr_id = e.pr_id_a
       AND src.repo_id = e.repo_id
      JOIN pull_requests candidate
        ON candidate.pr_id = e.pr_id_b
       AND candidate.repo_id = e.repo_id
      WHERE e.analysis_run_id = $1::uuid
        ${minScoreClause}
      ORDER BY e.rank ASC
      LIMIT $${limitIndex}
      `,
      queryValues,
    );

    return result.rows.map((row) => {
      const rawScores = (row.scores_json ?? {}) as Record<string, unknown>;
      const rawEvidence = (row.evidence_json ?? {}) as Record<string, unknown>;
      const testsIntentOverlap = (rawEvidence.testsIntentOverlap ?? {}) as Record<string, unknown>;
      const docsOverlap = (rawEvidence.docsOverlap ?? {}) as Record<string, unknown>;
      const similarityValues = (rawEvidence.similarityValues ?? {}) as Record<string, unknown>;

      return {
        analysisRunId: String(row.analysis_run_id),
        prNumber: Number(row.pr_number),
        headSha: String(row.head_sha),
        candidatePrNumber: Number(row.candidate_pr_number),
        candidatePrId: Number(row.candidate_pr_id),
        candidateHeadSha: String(row.candidate_head_sha),
        candidateUrl: String(row.candidate_pr_url),
        rank: Number(row.rank),
        category: String(row.category) as
          | "SAME_CHANGE"
          | "SAME_FEATURE"
          | "COMPETING_IMPLEMENTATION"
          | "RELATED"
          | "NOT_RELATED"
          | "UNCERTAIN",
        finalScore: Number(row.final_score),
        scores: {
          prodDiffExact: normalizeStringOrNumber(rawScores.prodDiffExact),
          prodMinhash: normalizeStringOrNumber(rawScores.prodMinhash),
          prodFiles: normalizeStringOrNumber(rawScores.prodFiles),
          prodExports: normalizeStringOrNumber(rawScores.prodExports),
          prodSymbols: normalizeStringOrNumber(rawScores.prodSymbols),
          prodImports: normalizeStringOrNumber(rawScores.prodImports),
          testsIntent: normalizeStringOrNumber(rawScores.testsIntent),
          docsStruct: normalizeStringOrNumber(rawScores.docsStruct),
        },
        evidence: {
          overlappingProductionPaths: normalizeStringArray(
            rawEvidence.overlappingProductionPaths,
          ),
          overlappingExports: normalizeStringArray(rawEvidence.overlappingExports),
          overlappingSymbols: normalizeStringArray(rawEvidence.overlappingSymbols),
          overlappingImports: normalizeStringArray(rawEvidence.overlappingImports),
          testsIntentOverlap: {
            suiteNames: normalizeStringArray(testsIntentOverlap.suiteNames),
            testNames: normalizeStringArray(testsIntentOverlap.testNames),
            matchers: normalizeStringArray(testsIntentOverlap.matchers),
          },
          docsOverlap: {
            headings: normalizeStringArray(docsOverlap.headings),
            codeFences: normalizeStringArray(docsOverlap.codeFences),
          },
          similarityValues: {
            prodDiffExact: normalizeStringOrNumber(similarityValues.prodDiffExact),
            prodMinhash: normalizeStringOrNumber(similarityValues.prodMinhash),
            prodFiles: normalizeStringOrNumber(similarityValues.prodFiles),
            prodExports: normalizeStringOrNumber(similarityValues.prodExports),
            prodSymbols: normalizeStringOrNumber(similarityValues.prodSymbols),
            prodImports: normalizeStringOrNumber(similarityValues.prodImports),
            testsIntent: normalizeStringOrNumber(similarityValues.testsIntent),
            docsStruct: normalizeStringOrNumber(similarityValues.docsStruct),
          },
        },
      };
    });
  }

  async listDuplicateSetNodes(params: {
    repoId: number;
    state: "OPEN" | "CLOSED" | "MERGED";
    needsReview: boolean;
    reviewThreshold: number;
    maxNodes: number;
  }): Promise<DuplicateSetNode[]> {
    const { repoId, state, needsReview, reviewThreshold, maxNodes } = params;

    const needsReviewClause = needsReview
      ? "AND top.final_score IS NOT NULL AND top.final_score >= $3"
      : "";

    const result = await this.pool.query(
      `
      SELECT
        pr.pr_id,
        pr.number,
        pr.last_analyzed_head_sha,
        pr.title,
        pr.url,
        pr.state,
        pr.last_analyzed_at,
        run.analysis_run_id
      FROM pull_requests pr
      JOIN LATERAL (
        SELECT analysis_run_id
        FROM pr_analysis_runs
        WHERE repo_id = pr.repo_id
          AND pr_id = pr.pr_id
          AND head_sha = pr.last_analyzed_head_sha
        ORDER BY started_at DESC
        LIMIT 1
      ) run ON TRUE
      LEFT JOIN LATERAL (
        SELECT e.final_score
        FROM pr_analysis_runs r
        JOIN pr_candidate_edges e ON e.analysis_run_id = r.analysis_run_id
        WHERE r.repo_id = pr.repo_id
          AND r.pr_id = pr.pr_id
          AND r.head_sha = pr.last_analyzed_head_sha
        ORDER BY r.started_at DESC, e.rank ASC
        LIMIT 1
      ) top ON TRUE
      WHERE pr.repo_id = $1
        AND pr.state = $2::pr_state
        AND pr.last_analyzed_head_sha IS NOT NULL
        ${needsReviewClause}
      ORDER BY pr.last_analyzed_at DESC NULLS LAST, pr.pr_id DESC
      LIMIT $4
      `,
      [repoId, state, reviewThreshold, maxNodes],
    );

    return result.rows.map((row) => ({
      prId: Number(row.pr_id),
      prNumber: Number(row.number),
      headSha: String(row.last_analyzed_head_sha),
      title: String(row.title),
      url: String(row.url),
      state: String(row.state) as "OPEN" | "CLOSED" | "MERGED",
      lastAnalyzedAt: new Date(row.last_analyzed_at),
      analysisRunId: String(row.analysis_run_id),
    }));
  }

  async listDuplicateSetEdges(params: {
    repoId: number;
    analysisRunIds: string[];
    minScore: number;
    includeCategories: Array<
      | "SAME_CHANGE"
      | "SAME_FEATURE"
      | "COMPETING_IMPLEMENTATION"
      | "RELATED"
      | "NOT_RELATED"
      | "UNCERTAIN"
    >;
  }): Promise<DuplicateSetEdge[]> {
    const { repoId, analysisRunIds, minScore, includeCategories } = params;

    if (analysisRunIds.length === 0 || includeCategories.length === 0) {
      return [];
    }

    const result = await this.pool.query(
      `
      SELECT
        pr_id_a,
        head_sha_a,
        pr_id_b,
        head_sha_b,
        category,
        final_score,
        evidence_json
      FROM pr_candidate_edges
      WHERE repo_id = $1
        AND analysis_run_id = ANY($2::uuid[])
        AND final_score >= $3
        AND category = ANY($4::triage_category[])
      `,
      [repoId, analysisRunIds, minScore, includeCategories],
    );

    return result.rows.map((row) => ({
      prIdA: Number(row.pr_id_a),
      headShaA: String(row.head_sha_a),
      prIdB: Number(row.pr_id_b),
      headShaB: String(row.head_sha_b),
      category: String(row.category) as
        | "SAME_CHANGE"
        | "SAME_FEATURE"
        | "COMPETING_IMPLEMENTATION"
        | "RELATED"
        | "NOT_RELATED"
        | "UNCERTAIN",
      finalScore: Number(row.final_score),
      evidence: row.evidence_json ?? {},
    }));
  }
}
