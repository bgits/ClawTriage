import { randomUUID } from "node:crypto";
import path from "node:path";
import { Queue, Worker } from "bullmq";
import { Redis } from "ioredis";
import {
  INTERNAL_PUBLIC_INSTALLATION_ID,
  JOB_NAMES,
  QUEUE_NAMES,
  bufferToMinhash,
  buildCanonicalDiffHash,
  buildIngestPrJobId,
  buildTokenShingles,
  classifyFiles,
  computeMinhash,
  extractAddedRemovedLines,
  extractDocsStructure,
  extractProductionSignalsFromFiles,
  extractTestIntent,
  jaccardFromArrays,
  lshBucketIds,
  loadClassificationRules,
  loadRuntimeConfig,
  loadThresholds,
  minhashSimilarity,
  minhashToBuffer,
  overlap,
  scoreCandidate,
  tokenizeLine,
  tokensFromDocsStructure,
  tokensFromTestIntent,
  type ChangedFile,
  type IngestPrJobPayload,
  type PublicPrScanJobPayload,
} from "@clawtriage/core";
import { GithubClient, PublicGithubClient } from "@clawtriage/github";
import { Storage } from "@clawtriage/storage";

const runtime = loadRuntimeConfig();
const rules = loadClassificationRules();
const thresholds = loadThresholds();

const storage = new Storage();
const github =
  runtime.githubAppId && runtime.githubPrivateKeyPem
    ? new GithubClient({
        appId: runtime.githubAppId,
        privateKeyPem: runtime.githubPrivateKeyPem,
      })
    : null;
const publicGithub = new PublicGithubClient({
  token: process.env.GITHUB_TOKEN,
});

const redis = new Redis(runtime.redisUrl, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
});

function toBullMqConnection(redisUrl: string) {
  const parsed = new URL(redisUrl);
  const db = parsed.pathname && parsed.pathname !== "/" ? Number(parsed.pathname.slice(1)) : 0;

  return {
    host: parsed.hostname,
    port: parsed.port ? Number(parsed.port) : 6379,
    username: parsed.username || undefined,
    password: parsed.password || undefined,
    db: Number.isFinite(db) ? db : 0,
    tls: parsed.protocol === "rediss:" ? {} : undefined,
    maxRetriesPerRequest: null as number | null,
  };
}

const workerConnection = toBullMqConnection(runtime.redisUrl);
const ingestQueue = new Queue<IngestPrJobPayload>(QUEUE_NAMES.ingestPr, {
  connection: workerConnection,
});

function mapPrState(state: "open" | "closed", mergedAt: string | null): "OPEN" | "CLOSED" | "MERGED" {
  if (state === "open") {
    return "OPEN";
  }

  return mergedAt ? "MERGED" : "CLOSED";
}

function mapFileStatus(
  status: "added" | "modified" | "removed" | "renamed",
): "ADDED" | "MODIFIED" | "REMOVED" | "RENAMED" {
  switch (status) {
    case "added":
      return "ADDED";
    case "modified":
      return "MODIFIED";
    case "removed":
      return "REMOVED";
    case "renamed":
      return "RENAMED";
    default:
      return "MODIFIED";
  }
}

function toDirPrefixes(filePath: string): {
  dirPrefix1: string | null;
  dirPrefix2: string | null;
  dirPrefix3: string | null;
} {
  const normalized = filePath.split(path.sep).join("/");
  const parts = normalized.split("/");

  if (parts.length <= 1) {
    return {
      dirPrefix1: null,
      dirPrefix2: null,
      dirPrefix3: null,
    };
  }

  const dirParts = parts.slice(0, -1);
  return {
    dirPrefix1: dirParts.length >= 1 ? dirParts.slice(0, 1).join("/") : null,
    dirPrefix2: dirParts.length >= 2 ? dirParts.slice(0, 2).join("/") : null,
    dirPrefix3: dirParts.length >= 3 ? dirParts.slice(0, 3).join("/") : null,
  };
}

function lshRedisKey(repoId: number, bucketId: string, signatureVersion: number): string {
  return `lsh:production:v${signatureVersion}:repo:${repoId}:bucket:${bucketId}`;
}

async function getLshCandidatePrIds(params: {
  repoId: number;
  bucketIds: string[];
  signatureVersion: number;
  maxCandidates: number;
}): Promise<number[]> {
  const { repoId, bucketIds, signatureVersion, maxCandidates } = params;
  if (bucketIds.length === 0) {
    return [];
  }

  const pipeline = redis.pipeline();
  for (const bucketId of bucketIds) {
    pipeline.smembers(lshRedisKey(repoId, bucketId, signatureVersion));
  }

  const results = await pipeline.exec();
  const prIds: number[] = [];
  const seen = new Set<number>();

  for (const result of results ?? []) {
    const members = result[1] as string[];
    if (!Array.isArray(members)) {
      continue;
    }

    for (const member of members) {
      const [rawPrId] = member.split(":");
      const parsed = Number(rawPrId);
      if (Number.isInteger(parsed) && !seen.has(parsed)) {
        seen.add(parsed);
        prIds.push(parsed);
      }
      if (prIds.length >= maxCandidates) {
        return prIds;
      }
    }
  }

  return prIds;
}

async function insertIntoLsh(params: {
  repoId: number;
  prId: number;
  headSha: string;
  bucketIds: string[];
  signatureVersion: number;
}): Promise<void> {
  const { repoId, prId, headSha, bucketIds, signatureVersion } = params;
  if (bucketIds.length === 0) {
    return;
  }

  const ttlSeconds = thresholds.candidates.recent_pr_window_days * 24 * 60 * 60;
  const member = `${prId}:${headSha}`;

  const pipeline = redis.pipeline();
  for (const bucketId of bucketIds) {
    const key = lshRedisKey(repoId, bucketId, signatureVersion);
    pipeline.sadd(key, member);
    pipeline.expire(key, ttlSeconds);
  }
  await pipeline.exec();
}

function collectPatchLines(files: ChangedFile[]): string[] {
  return files.flatMap((file) => {
    if (!file.patch) {
      return [];
    }

    return extractAddedRemovedLines(file.patch).map((line) => line.slice(1));
  });
}

function toShinglesFromPatchLines(lines: string[]): Set<string> {
  const tokens = lines.flatMap((line) => tokenizeLine(line));
  return buildTokenShingles(tokens, 5);
}

async function fetchPullRequestForIngest(payload: IngestPrJobPayload) {
  if (payload.installationId === INTERNAL_PUBLIC_INSTALLATION_ID) {
    return publicGithub.fetchPullRequestData({
      owner: payload.owner,
      repo: payload.repo,
      prNumber: payload.prNumber,
    });
  }

  if (!github) {
    throw new Error(
      "GitHub App ingest requested but app credentials are not configured. Set GITHUB_MODE=app|hybrid and provide GITHUB_APP_ID/GITHUB_PRIVATE_KEY_PEM.",
    );
  }

  return github.fetchPullRequestData({
    installationId: payload.installationId,
    owner: payload.owner,
    repo: payload.repo,
    prNumber: payload.prNumber,
  });
}

async function processPublicPrScan(payload: PublicPrScanJobPayload): Promise<void> {
  const repoData = await publicGithub.fetchRepositoryData({
    owner: payload.owner,
    repo: payload.repo,
  });

  await storage.upsertInstallation({
    installationId: INTERNAL_PUBLIC_INSTALLATION_ID,
    accountLogin: repoData.ownerLogin,
    accountType: repoData.ownerType,
  });

  await storage.upsertRepository({
    repoId: repoData.id,
    installationId: INTERNAL_PUBLIC_INSTALLATION_ID,
    owner: repoData.ownerLogin,
    name: repoData.name,
    defaultBranch: repoData.defaultBranch,
    isActive: true,
  });

  const openPrs = await publicGithub.listOpenPullRequests({
    owner: repoData.ownerLogin,
    repo: repoData.name,
    maxOpenPrs: payload.maxOpenPrs,
  });

  for (const pr of openPrs) {
    const ingestPayload: IngestPrJobPayload = {
      deliveryId: `public-${payload.snapshot}-${pr.id}-${pr.headSha.slice(0, 12)}`,
      installationId: INTERNAL_PUBLIC_INSTALLATION_ID,
      repoId: repoData.id,
      owner: repoData.ownerLogin,
      repo: repoData.name,
      prNumber: pr.number,
      prId: pr.id,
      headSha: pr.headSha,
      action: "public_scan",
    };
    const ingestJobId = buildIngestPrJobId(ingestPayload);

    const existingJob = await ingestQueue.getJob(ingestJobId);
    if (existingJob) {
      const state = await existingJob.getState();
      if (state === "failed") {
        await existingJob.remove();
      } else {
        continue;
      }
    }

    await ingestQueue.add(JOB_NAMES.ingestPr, ingestPayload, {
      jobId: ingestJobId,
      removeOnComplete: 500,
      removeOnFail: 1000,
    });
  }

  // eslint-disable-next-line no-console
  console.log(
    `Public scan queued ${openPrs.length} PR(s) for ${repoData.ownerLogin}/${repoData.name}`,
  );
}

async function processIngestPr(payload: IngestPrJobPayload): Promise<void> {
  const prData = await fetchPullRequestForIngest(payload);

  const classifiedFiles = classifyFiles(
    prData.files.map((file) => ({
      path: file.filename,
      previousPath: file.previousFilename,
      status: mapFileStatus(file.status),
      additions: file.additions,
      deletions: file.deletions,
      patch: file.patch,
      patchTruncated: file.truncated,
    })),
    rules,
  );

  await storage.upsertPullRequest({
    prId: prData.id,
    repoId: payload.repoId,
    number: prData.number,
    state: mapPrState(prData.state, prData.mergedAt),
    isDraft: prData.draft,
    title: prData.title,
    body: prData.body,
    authorLogin: prData.authorLogin,
    url: prData.htmlUrl,
    baseRef: prData.baseRef,
    baseSha: prData.baseSha,
    headRef: prData.headRef,
    headRepoFullName: prData.headRepoFullName,
    headSha: prData.headSha,
    additions: prData.additions,
    deletions: prData.deletions,
    changedFiles: prData.changedFiles,
    createdAt: new Date(prData.createdAt),
    updatedAt: new Date(prData.updatedAt),
    closedAt: prData.closedAt ? new Date(prData.closedAt) : null,
    mergedAt: prData.mergedAt ? new Date(prData.mergedAt) : null,
    lastIngestedDeliveryId: payload.deliveryId,
    analysisStatus: "RUNNING",
  });

  await storage.updatePullRequestAnalysisStatus(prData.id, {
    analysisStatus: "RUNNING",
    analysisError: null,
  });

  await storage.replacePrFiles(
    prData.id,
    prData.headSha,
    classifiedFiles.map((file) => ({
      repoId: payload.repoId,
      prId: prData.id,
      headSha: prData.headSha,
      path: file.path,
      previousPath: file.previousPath ?? null,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      patchTruncated: Boolean(file.patchTruncated),
      channel: file.channel,
      detectedLanguage: null,
    })),
  );

  await storage.replaceChangedPaths(
    prData.id,
    prData.headSha,
    classifiedFiles.map((file) => {
      const prefixes = toDirPrefixes(file.path);
      return {
        repoId: payload.repoId,
        prId: prData.id,
        headSha: prData.headSha,
        channel: file.channel,
        path: file.path,
        dirPrefix1: prefixes.dirPrefix1,
        dirPrefix2: prefixes.dirPrefix2,
        dirPrefix3: prefixes.dirPrefix3,
      };
    }),
  );

  const productionFiles = classifiedFiles.filter((file) => file.channel === "PRODUCTION");
  const testsFiles = classifiedFiles.filter((file) => file.channel === "TESTS");
  const docsFiles = classifiedFiles.filter((file) => file.channel === "DOCS");
  const metaFiles = classifiedFiles.filter((file) => file.channel === "META");

  const productionSignals = extractProductionSignalsFromFiles(productionFiles);
  await storage.replaceSymbols(
    prData.id,
    prData.headSha,
    [
      ...productionSignals.symbols.map((symbol) => ({
        repoId: payload.repoId,
        prId: prData.id,
        headSha: prData.headSha,
        symbol,
        kind: "decl" as const,
      })),
      ...productionSignals.exports.map((symbol) => ({
        repoId: payload.repoId,
        prId: prData.id,
        headSha: prData.headSha,
        symbol,
        kind: "export" as const,
      })),
      ...productionSignals.imports.map((symbol) => ({
        repoId: payload.repoId,
        prId: prData.id,
        headSha: prData.headSha,
        symbol,
        kind: "import" as const,
      })),
    ],
  );

  const productionPatchInputs = productionFiles.map((file) => ({
    path: file.path,
    patch: file.patch,
  }));
  const productionPatchLines = collectPatchLines(productionFiles);
  const productionShingles = toShinglesFromPatchLines(productionPatchLines);
  // Deterministic minhash computation: empty shingle sets still produce a stable max-signature.
  const prodSignature = computeMinhash(productionShingles);

  const canonicalDiff = buildCanonicalDiffHash(productionPatchInputs);
  const hasProductionPatchLines = productionPatchLines.length > 0;
  const canonicalDiffHash = hasProductionPatchLines ? canonicalDiff.hash : null;

  const testIntent = extractTestIntent(testsFiles);
  const docsStructure = extractDocsStructure(docsFiles);

  const testIntentTokens = tokensFromTestIntent(testIntent);
  const docsTokens = tokensFromDocsStructure(docsStructure);

  const testShingles = buildTokenShingles(testIntentTokens, 3);
  const docsShingles = buildTokenShingles(docsTokens, 3);

  const testsMinhash = computeMinhash(testShingles);
  const docsMinhash = computeMinhash(docsShingles);

  await storage.upsertChannelSignature({
    prId: prData.id,
    repoId: payload.repoId,
    headSha: prData.headSha,
    channel: "PRODUCTION",
    signatureVersion: runtime.signatureVersion,
    canonicalDiffHash,
    minhash: minhashToBuffer(prodSignature),
    minhashShingleCount: productionShingles.size,
    exportsJson: productionSignals.exports,
    symbolsJson: productionSignals.symbols,
    importsJson: productionSignals.imports,
    sizeMetricsJson: {
      files: productionFiles.length,
      additions: productionFiles.reduce((sum, file) => sum + file.additions, 0),
      deletions: productionFiles.reduce((sum, file) => sum + file.deletions, 0),
    },
  });

  await storage.upsertChannelSignature({
    prId: prData.id,
    repoId: payload.repoId,
    headSha: prData.headSha,
    channel: "TESTS",
    signatureVersion: runtime.signatureVersion,
    minhash: minhashToBuffer(testsMinhash),
    minhashShingleCount: testShingles.size,
    testIntentJson: testIntent,
    sizeMetricsJson: {
      files: testsFiles.length,
      additions: testsFiles.reduce((sum, file) => sum + file.additions, 0),
      deletions: testsFiles.reduce((sum, file) => sum + file.deletions, 0),
    },
  });

  await storage.upsertChannelSignature({
    prId: prData.id,
    repoId: payload.repoId,
    headSha: prData.headSha,
    channel: "DOCS",
    signatureVersion: runtime.signatureVersion,
    minhash: minhashToBuffer(docsMinhash),
    minhashShingleCount: docsShingles.size,
    docStructureJson: docsStructure,
    sizeMetricsJson: {
      files: docsFiles.length,
      additions: docsFiles.reduce((sum, file) => sum + file.additions, 0),
      deletions: docsFiles.reduce((sum, file) => sum + file.deletions, 0),
    },
  });

  await storage.upsertChannelSignature({
    prId: prData.id,
    repoId: payload.repoId,
    headSha: prData.headSha,
    channel: "META",
    signatureVersion: runtime.signatureVersion,
    minhashShingleCount: 0,
    sizeMetricsJson: {
      files: metaFiles.length,
      additions: metaFiles.reduce((sum, file) => sum + file.additions, 0),
      deletions: metaFiles.reduce((sum, file) => sum + file.deletions, 0),
    },
  });

  const analysisRunId = randomUUID();
  await storage.insertAnalysisRun({
    analysisRunId,
    repoId: payload.repoId,
    prId: prData.id,
    headSha: prData.headSha,
    signatureVersion: runtime.signatureVersion,
    algorithmVersion: runtime.algorithmVersion,
    configVersion: thresholds.version,
    status: "RUNNING",
    startedAt: new Date(),
  });

  const degradedReasons: string[] = [];
  if (productionFiles.some((file) => !file.patch)) {
    degradedReasons.push("missing_production_patch_segments");
  }

  const candidateByKey = new Map<string, { prId: number; headSha: string }>();

  if (canonicalDiffHash) {
    const exactHashCandidates = await storage.findCandidatesByCanonicalDiffHash(
      payload.repoId,
      canonicalDiffHash,
      runtime.signatureVersion,
      prData.id,
      thresholds.candidates.max_candidates_from_lsh,
    );

    for (const ref of exactHashCandidates) {
      candidateByKey.set(`${ref.prId}:${ref.headSha}`, ref);
    }
  }

  const bucketIds =
    productionShingles.size > 0 ? lshBucketIds(prodSignature) : [];

  if (bucketIds.length > 0) {
    const lshCandidatePrIds = await getLshCandidatePrIds({
      repoId: payload.repoId,
      bucketIds,
      signatureVersion: runtime.signatureVersion,
      maxCandidates: thresholds.candidates.max_candidates_from_lsh,
    });

    const lshRefs = await storage.getCurrentHeadsForPrIds(
      payload.repoId,
      lshCandidatePrIds,
      prData.id,
      thresholds.candidates.max_candidates_from_lsh,
    );

    for (const ref of lshRefs) {
      candidateByKey.set(`${ref.prId}:${ref.headSha}`, ref);
    }
  }

  const productionPaths = productionFiles.map((file) => file.path).sort((a, b) => a.localeCompare(b));

  if (productionPaths.length > 0) {
    const pathCandidates = await storage.findCandidatesByPaths(
      payload.repoId,
      productionPaths,
      prData.id,
      thresholds.candidates.max_candidates_from_lsh,
    );

    for (const ref of pathCandidates) {
      candidateByKey.set(`${ref.prId}:${ref.headSha}`, ref);
    }
  }

  const symbolSeed = [
    ...productionSignals.exports,
    ...productionSignals.symbols,
    ...productionSignals.imports,
  ];

  if (symbolSeed.length > 0) {
    const symbolCandidates = await storage.findCandidatesBySymbols(
      payload.repoId,
      symbolSeed,
      ["export", "decl", "import"],
      prData.id,
      thresholds.candidates.max_candidates_from_lsh,
    );

    for (const ref of symbolCandidates) {
      candidateByKey.set(`${ref.prId}:${ref.headSha}`, ref);
    }
  }

  const candidates = Array.from(candidateByKey.values()).slice(
    0,
    thresholds.candidates.max_candidates_from_lsh,
  );

  const scored = [] as Array<{
    prId: number;
    headSha: string;
    category: "SAME_CHANGE" | "SAME_FEATURE" | "COMPETING_IMPLEMENTATION" | "RELATED";
    finalScore: number;
    scores: {
      prodDiffExact: number;
      prodMinhash: number;
      prodFiles: number;
      prodExports: number;
      prodSymbols: number;
      prodImports: number;
      testsIntent: number;
      docsStruct: number;
    };
    evidence: {
      overlappingProductionPaths: string[];
      overlappingExports: string[];
      overlappingSymbols: string[];
      overlappingImports: string[];
      testsIntentOverlap: {
        suiteNames: string[];
        testNames: string[];
        matchers: string[];
      };
      docsOverlap: {
        headings: string[];
        codeFences: string[];
      };
      similarityValues: {
        prodDiffExact: number;
        prodMinhash: number;
        prodFiles: number;
        prodExports: number;
        prodSymbols: number;
        prodImports: number;
        testsIntent: number;
        docsStruct: number;
      };
    };
  }>;

  const currentTestIntentTokens = tokensFromTestIntent(testIntent);
  const currentDocsTokens = tokensFromDocsStructure(docsStructure);

  for (const candidate of candidates) {
    const candidateSignature = await storage.getProductionSignature(
      payload.repoId,
      candidate.prId,
      candidate.headSha,
      runtime.signatureVersion,
    );

    if (!candidateSignature) {
      continue;
    }

    const candidatePaths = await storage.getPathsForPrHead(
      payload.repoId,
      candidate.prId,
      candidate.headSha,
      "PRODUCTION",
    );

    const candidateMinhash = candidateSignature.minhash ? bufferToMinhash(candidateSignature.minhash) : null;

    const candidateTestIntentTokens = candidateSignature.testIntentJson ?
      [
        ...candidateSignature.testIntentJson.suiteNames,
        ...candidateSignature.testIntentJson.testNames,
        ...candidateSignature.testIntentJson.matchers,
        ...candidateSignature.testIntentJson.importsUnderTest,
      ]
    : [];

    const candidateDocsTokens = candidateSignature.docStructureJson ?
      [
        ...candidateSignature.docStructureJson.headings,
        ...candidateSignature.docStructureJson.codeFences,
        ...candidateSignature.docStructureJson.references,
      ]
    : [];

    const scores = {
      prodDiffExact:
        canonicalDiffHash && candidateSignature.canonicalDiffHash && canonicalDiffHash === candidateSignature.canonicalDiffHash ?
          1
        : 0,
      prodMinhash:
        candidateMinhash && productionShingles.size > 0 ?
          minhashSimilarity(prodSignature, candidateMinhash)
        : 0,
      prodFiles: jaccardFromArrays(productionPaths, candidatePaths),
      prodExports: jaccardFromArrays(productionSignals.exports, candidateSignature.exportsJson),
      prodSymbols: jaccardFromArrays(productionSignals.symbols, candidateSignature.symbolsJson),
      prodImports: jaccardFromArrays(productionSignals.imports, candidateSignature.importsJson),
      testsIntent: jaccardFromArrays(currentTestIntentTokens, candidateTestIntentTokens),
      docsStruct: jaccardFromArrays(currentDocsTokens, candidateDocsTokens),
    };

    const categorization = scoreCandidate(scores, thresholds, runtime.reviewScoreThreshold);

    if (
      categorization.category !== "SAME_CHANGE" &&
      categorization.category !== "SAME_FEATURE" &&
      categorization.category !== "COMPETING_IMPLEMENTATION" &&
      categorization.category !== "RELATED"
    ) {
      continue;
    }

    const candidateTest = candidateSignature.testIntentJson;
    const candidateDocs = candidateSignature.docStructureJson;

    scored.push({
      prId: candidate.prId,
      headSha: candidate.headSha,
      category: categorization.category,
      finalScore: categorization.finalScore,
      scores,
      evidence: {
        overlappingProductionPaths: overlap(productionPaths, candidatePaths).slice(0, 10),
        overlappingExports: overlap(productionSignals.exports, candidateSignature.exportsJson).slice(0, 20),
        overlappingSymbols: overlap(productionSignals.symbols, candidateSignature.symbolsJson).slice(0, 20),
        overlappingImports: overlap(productionSignals.imports, candidateSignature.importsJson).slice(0, 20),
        testsIntentOverlap: {
          suiteNames: overlap(testIntent.suiteNames, candidateTest?.suiteNames ?? []).slice(0, 10),
          testNames: overlap(testIntent.testNames, candidateTest?.testNames ?? []).slice(0, 10),
          matchers: overlap(testIntent.matchers, candidateTest?.matchers ?? []).slice(0, 10),
        },
        docsOverlap: {
          headings: overlap(docsStructure.headings, candidateDocs?.headings ?? []).slice(0, 10),
          codeFences: overlap(docsStructure.codeFences, candidateDocs?.codeFences ?? []).slice(0, 10),
        },
        similarityValues: scores,
      },
    });
  }

  const categoryRank = {
    SAME_CHANGE: 0,
    SAME_FEATURE: 1,
    COMPETING_IMPLEMENTATION: 2,
    RELATED: 3,
  } as const;

  scored.sort((a, b) => {
    const categoryDelta = categoryRank[a.category] - categoryRank[b.category];
    if (categoryDelta !== 0) {
      return categoryDelta;
    }
    if (b.finalScore !== a.finalScore) {
      return b.finalScore - a.finalScore;
    }
    return a.prId - b.prId;
  });

  const limited = scored.slice(0, thresholds.candidates.max_candidates_final);

  await storage.insertCandidateEdges(
    limited.map((candidate, index) => ({
      analysisRunId,
      repoId: payload.repoId,
      prIdA: prData.id,
      headShaA: prData.headSha,
      prIdB: candidate.prId,
      headShaB: candidate.headSha,
      rank: index + 1,
      category: candidate.category,
      finalScore: candidate.finalScore,
      scoresJson: {
        prodDiffExact: candidate.scores.prodDiffExact,
        prodMinhash: candidate.scores.prodMinhash,
        prodFiles: candidate.scores.prodFiles,
        prodExports: candidate.scores.prodExports,
        prodSymbols: candidate.scores.prodSymbols,
        prodImports: candidate.scores.prodImports,
        testsIntent: candidate.scores.testsIntent,
        docsStruct: candidate.scores.docsStruct,
      },
      evidenceJson: candidate.evidence,
    })),
  );

  await insertIntoLsh({
    repoId: payload.repoId,
    prId: prData.id,
    headSha: prData.headSha,
    bucketIds,
    signatureVersion: runtime.signatureVersion,
  });

  const finalStatus = degradedReasons.length > 0 ? "DEGRADED" : "DONE";

  await storage.finishAnalysisRun(
    analysisRunId,
    finalStatus,
    undefined,
    degradedReasons.length > 0 ? degradedReasons : undefined,
  );

  await storage.updatePullRequestAnalysisStatus(prData.id, {
    analysisStatus: finalStatus,
    analysisError: null,
    lastAnalyzedHeadSha: prData.headSha,
  });

  if (
    thresholds.actions.publish_check_run &&
    payload.installationId !== INTERNAL_PUBLIC_INSTALLATION_ID
  ) {
    if (!github) {
      degradedReasons.push("check_run_publish_skipped_missing_github_app_config");
      await storage.finishAnalysisRun(
        analysisRunId,
        "DEGRADED",
        undefined,
        degradedReasons,
      );
      await storage.updatePullRequestAnalysisStatus(prData.id, {
        analysisStatus: "DEGRADED",
        analysisError: null,
        lastAnalyzedHeadSha: prData.headSha,
      });
      return;
    }

    try {
      const prNumbers = await storage.getPrNumberMap(
        payload.repoId,
        limited.map((candidate) => candidate.prId),
      );

      if (limited.length === 0) {
        await github.publishCheckRunSummary({
          installationId: payload.installationId,
          owner: payload.owner,
          repo: payload.repo,
          headSha: prData.headSha,
          name: runtime.checkRunName,
          title: "No likely duplicates found",
          summary:
            "ClawTriage did not find likely duplicate PRs from production-channel signatures for this head SHA.",
        });
      } else {
        const top = limited.slice(0, 5);
        const summaryLines = top.map((entry) => {
          const candidateNumber = prNumbers.get(entry.prId) ?? entry.prId;
          const paths = entry.evidence.overlappingProductionPaths.slice(0, 2).join(", ");
          const pathText = paths.length > 0 ? `paths: ${paths}` : "paths: none";
          return `- #${candidateNumber} | ${entry.category} | score ${entry.finalScore.toFixed(3)} | ${pathText}`;
        });

        await github.publishCheckRunSummary({
          installationId: payload.installationId,
          owner: payload.owner,
          repo: payload.repo,
          headSha: prData.headSha,
          name: runtime.checkRunName,
          title: "Possible duplicate PRs",
          summary: summaryLines.join("\n"),
          text:
            "Production signals dominate this decision. Tests/docs evidence is included only as supporting context.",
        });
      }
    } catch (error) {
      degradedReasons.push(`check_run_publish_failed:${(error as Error).message}`);
      await storage.finishAnalysisRun(
        analysisRunId,
        "DEGRADED",
        undefined,
        degradedReasons,
      );
      await storage.updatePullRequestAnalysisStatus(prData.id, {
        analysisStatus: "DEGRADED",
        analysisError: null,
        lastAnalyzedHeadSha: prData.headSha,
      });
    }
  }
}

const ingestWorker = new Worker<IngestPrJobPayload>(
  QUEUE_NAMES.ingestPr,
  async (job) => {
    if (job.name !== JOB_NAMES.ingestPr) {
      return;
    }

    await processIngestPr(job.data);
  },
  {
    concurrency: runtime.workerConcurrency,
    connection: workerConnection,
  },
);

const publicScanWorker = new Worker<PublicPrScanJobPayload>(
  QUEUE_NAMES.publicPrScan,
  async (job) => {
    if (job.name !== JOB_NAMES.publicPrScan) {
      return;
    }

    await processPublicPrScan(job.data);
  },
  {
    concurrency: 1,
    connection: workerConnection,
  },
);

ingestWorker.on("completed", (job) => {
  // eslint-disable-next-line no-console
  console.log(`Completed ingest job ${job.id}`);
});

publicScanWorker.on("completed", (job) => {
  // eslint-disable-next-line no-console
  console.log(`Completed public scan job ${job.id}`);
});

ingestWorker.on("failed", async (job, error) => {
  // eslint-disable-next-line no-console
  console.error(`Failed ingest job ${job?.id}:`, error);

  const payload = job?.data;
  if (payload?.prId) {
    await storage.updatePullRequestAnalysisStatus(payload.prId, {
      analysisStatus: "FAILED",
      analysisError: error.message,
      lastAnalyzedHeadSha: payload.headSha,
    });
  }
});

publicScanWorker.on("failed", (job, error) => {
  // eslint-disable-next-line no-console
  console.error(`Failed public scan job ${job?.id}:`, error);
});

async function shutdown(): Promise<void> {
  await ingestWorker.close();
  await publicScanWorker.close();
  await ingestQueue.close();
  await redis.quit();
  await storage.close();
}

process.on("SIGINT", () => {
  shutdown().finally(() => process.exit(0));
});

process.on("SIGTERM", () => {
  shutdown().finally(() => process.exit(0));
});

// eslint-disable-next-line no-console
console.log("Worker started");
