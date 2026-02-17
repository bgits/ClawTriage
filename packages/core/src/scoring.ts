import type { PairScores, ScoredCategory, Thresholds } from "./types.js";

function clamp01(value: number): number {
  if (value < 0) {
    return 0;
  }
  if (value > 1) {
    return 1;
  }
  return value;
}

export function computeProdScore(scores: PairScores, thresholds: Thresholds): number {
  const w = thresholds.weights.production;
  return clamp01(
    w.minhash * scores.prodMinhash +
      w.exports * scores.prodExports +
      w.symbols * scores.prodSymbols +
      w.files * scores.prodFiles +
      w.imports * scores.prodImports,
  );
}

export function scoreCandidate(
  scores: PairScores,
  thresholds: Thresholds,
  reviewThreshold: number,
): ScoredCategory {
  const prodScore = computeProdScore(scores, thresholds);
  const testContribution = Math.min(
    thresholds.weights.tests.intent * scores.testsIntent,
    thresholds.caps.test_score_cap,
  );
  const docContribution = Math.min(
    thresholds.weights.docs.structure * scores.docsStruct,
    thresholds.caps.doc_score_cap,
  );
  const finalScore = clamp01(prodScore + testContribution + docContribution);

  if (
    scores.prodDiffExact === 1 ||
    (scores.prodMinhash >= thresholds.similarity.same_change.prod_minhash_threshold &&
      scores.prodFiles >= thresholds.similarity.same_change.prod_files_overlap_threshold)
  ) {
    return {
      category: "SAME_CHANGE",
      finalScore,
      prodScore,
    };
  }

  if (
    prodScore >= thresholds.similarity.same_feature.prod_score_threshold &&
    Math.max(scores.testsIntent, scores.docsStruct, scores.prodMinhash) >=
      thresholds.similarity.same_feature.supporting_signal_min
  ) {
    return {
      category: "SAME_FEATURE",
      finalScore,
      prodScore,
    };
  }

  if (
    scores.testsIntent >= thresholds.similarity.competing_impl.tests_intent_threshold &&
    prodScore <= thresholds.similarity.competing_impl.prod_score_max
  ) {
    return {
      category: "COMPETING_IMPLEMENTATION",
      finalScore,
      prodScore,
    };
  }

  if (finalScore >= reviewThreshold) {
    return {
      category: "RELATED",
      finalScore,
      prodScore,
    };
  }

  return {
    category: "NOT_RELATED",
    finalScore,
    prodScore,
  };
}

export function overlap(top: string[], other: string[]): string[] {
  const otherSet = new Set(other);
  return top.filter((entry) => otherSet.has(entry));
}

export function jaccardFromArrays(a: string[], b: string[]): number {
  const aSet = new Set(a);
  const bSet = new Set(b);

  if (aSet.size === 0 && bSet.size === 0) {
    return 1;
  }

  if (aSet.size === 0 || bSet.size === 0) {
    return 0;
  }

  let intersection = 0;
  for (const value of aSet) {
    if (bSet.has(value)) {
      intersection += 1;
    }
  }

  const union = aSet.size + bSet.size - intersection;
  return union === 0 ? 0 : intersection / union;
}
