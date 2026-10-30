/**
 * Semantic Candidate Retriever for Waspada Jakarta (Layer 1 Data Knowledge).
 *
 * Provides vector-assisted candidate discovery comparing incoming report evidence
 * against existing reports and incidents using cosine vector similarity combined
 * with spatio-temporal hints.
 *
 * In production with PostgreSQL/Neon, this connects to pgvector and
 * EvidenceRetrievalRepository. In Worker edge environments and standalone/offline
 * test runtimes, InMemorySemanticRetriever provides zero-dependency cosine
 * vector matching.
 */

import { haversineDistanceMeters } from "./geographic-gazetteer.js";

export interface SemanticCandidateQuery {
  readonly queryText: string;
  readonly queryVector?: readonly number[];
  readonly coordinates?: readonly [number, number] | null;
  readonly timestamp?: string | null;
  readonly maxCandidates?: number;
  readonly minSimilarity?: number;
}

export interface CandidateMatch<T = unknown> {
  readonly item: T;
  readonly similarityScore: number;
  readonly spatialDistanceMeters?: number | null;
  readonly temporalDeltaMs?: number | null;
}

export interface SemanticRetriever<T> {
  retrieveCandidates(query: SemanticCandidateQuery): Promise<readonly CandidateMatch<T>[]>;
}

/**
 * Computes cosine similarity between two numeric vectors.
 * Returns a value between -1.0 and 1.0 (or 0 for zero vectors).
 */
export function cosineSimilarity(
  a: readonly number[],
  b: readonly number[],
): number {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) {
    return 0;
  }
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const valA = a[i]!;
    const valB = b[i]!;
    dotProduct += valA * valB;
    normA += valA * valA;
    normB += valB * valB;
  }
  if (normA === 0 || normB === 0) {
    return 0;
  }
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Generates a deterministic normalized semantic hash vector for text.
 * Used for in-memory vector matching when an external embedding model is not attached.
 * Produces vectors of the specified dimension (default 64) with unit norm.
 */
export function generateDeterministicTextVector(
  text: string,
  dimensions = 64,
): readonly number[] {
  const normalized = text.toLowerCase().trim();
  if (normalized.length === 0) {
    return new Array(dimensions).fill(0);
  }

  const vector = new Array<number>(dimensions).fill(0);

  // Extract word tokens and character 3-grams
  const words = normalized.split(/[\s,.-_()]+/g).filter((w) => w.length > 0);
  for (const word of words) {
    let hash = 5381;
    for (let i = 0; i < word.length; i++) {
      hash = (hash * 33) ^ word.charCodeAt(i);
    }
    const idx = Math.abs(hash) % dimensions;
    vector[idx] = (vector[idx] ?? 0) + 1.0;
  }

  // 3-grams for morphological/root matching in Indonesian
  for (let i = 0; i < normalized.length - 2; i++) {
    const tri = normalized.slice(i, i + 3);
    let hash = 0;
    for (let j = 0; j < tri.length; j++) {
      hash = (hash << 5) - hash + tri.charCodeAt(j);
      hash |= 0;
    }
    const idx = Math.abs(hash) % dimensions;
    vector[idx] = (vector[idx] ?? 0) + 0.3;
  }

  // Normalize to unit vector
  let sumSq = 0;
  for (let i = 0; i < dimensions; i++) {
    sumSq += vector[i]! * vector[i]!;
  }
  const mag = Math.sqrt(sumSq);
  if (mag > 0) {
    for (let i = 0; i < dimensions; i++) {
      vector[i] = vector[i]! / mag;
    }
  }

  return vector;
}

export interface InMemporyItemAdapter<T> {
  readonly getText: (item: T) => string;
  readonly getCoordinates?: (item: T) => readonly [number, number] | null;
  readonly getTimestamp?: (item: T) => string | null;
  readonly getVector?: (item: T) => readonly number[] | undefined;
}

/**
 * In-memory semantic candidate retriever supporting vector cosine similarity,
 * spatial distance, and temporal delta.
 */
export class InMemorySemanticRetriever<T> implements SemanticRetriever<T> {
  private readonly items: T[] = [];
  private readonly vectorCache = new WeakMap<object, readonly number[]>();
  private readonly adapter: InMemporyItemAdapter<T>;

  constructor(adapter: InMemporyItemAdapter<T>, initialItems?: readonly T[]) {
    this.adapter = adapter;
    if (initialItems) {
      this.items.push(...initialItems);
    }
  }

  public addItem(item: T): void {
    this.items.push(item);
  }

  public setItems(items: readonly T[]): void {
    this.items.length = 0;
    this.items.push(...items);
  }

  public getItems(): readonly T[] {
    return this.items;
  }

  private getItemVector(item: T): readonly number[] {
    if (this.adapter.getVector) {
      const v = this.adapter.getVector(item);
      if (v && v.length > 0) return v;
    }
    if (typeof item === "object" && item !== null) {
      const cached = this.vectorCache.get(item);
      if (cached) return cached;
      const text = this.adapter.getText(item);
      const computed = generateDeterministicTextVector(text);
      this.vectorCache.set(item, computed);
      return computed;
    }
    const text = this.adapter.getText(item);
    return generateDeterministicTextVector(text);
  }

  public async retrieveCandidates(
    query: SemanticCandidateQuery,
  ): Promise<readonly CandidateMatch<T>[]> {
    if (this.items.length === 0) {
      return [];
    }

    const queryVec =
      query.queryVector && query.queryVector.length > 0
        ? query.queryVector
        : generateDeterministicTextVector(query.queryText);

    const maxCandidates = query.maxCandidates ?? 10;
    const minSimilarity = query.minSimilarity ?? 0.15;
    const queryTimeMs = query.timestamp ? Date.parse(query.timestamp) : null;

    const matches: CandidateMatch<T>[] = [];

    for (const item of this.items) {
      const itemVec = this.getItemVector(item);
      const similarity = cosineSimilarity(queryVec, itemVec);

      let spatialDistance: number | null = null;
      if (query.coordinates && this.adapter.getCoordinates) {
        const itemCoords = this.adapter.getCoordinates(item);
        if (itemCoords) {
          spatialDistance = haversineDistanceMeters(query.coordinates, itemCoords);
        }
      }

      let temporalDeltaMs: number | null = null;
      if (queryTimeMs !== null && Number.isFinite(queryTimeMs) && this.adapter.getTimestamp) {
        const itemTime = this.adapter.getTimestamp(item);
        if (itemTime) {
          const itemTimeMs = Date.parse(itemTime);
          if (Number.isFinite(itemTimeMs)) {
            temporalDeltaMs = Math.abs(queryTimeMs - itemTimeMs);
          }
        }
      }

      // Filter by min similarity or spatial proximity if coordinates available
      // (a very close report in distance might match even with different wording)
      const isSpatiallyClose = spatialDistance !== null && spatialDistance <= 3000;
      if (similarity >= minSimilarity || isSpatiallyClose) {
        matches.push({
          item,
          similarityScore: similarity,
          spatialDistanceMeters: spatialDistance,
          temporalDeltaMs,
        });
      }
    }

    // Rank candidates: higher similarity score first, with a mild distance bonus if within 1km
    matches.sort((a, b) => {
      let scoreA = a.similarityScore;
      let scoreB = b.similarityScore;

      if (a.spatialDistanceMeters !== null && a.spatialDistanceMeters !== undefined && a.spatialDistanceMeters < 1500) {
        scoreA += 0.2;
      }
      if (b.spatialDistanceMeters !== null && b.spatialDistanceMeters !== undefined && b.spatialDistanceMeters < 1500) {
        scoreB += 0.2;
      }

      return scoreB - scoreA;
    });

    return matches.slice(0, maxCandidates);
  }
}
