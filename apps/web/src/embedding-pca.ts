/**
 * Pure TypeScript Principal Component Analysis (PCA) dimensionality reduction module.
 *
 * Implements Dual Gram-Matrix PCA via Power Iteration with Deflation to project
 * 768-dimensional embedding vectors into 3-dimensional Cartesian coordinates (x, y, z)
 * suitable for Three.js rendering, computing variance ratios and nearest semantic neighbors.
 */

export interface EmbeddingInputRecord {
  readonly id: string;
  readonly vector: readonly number[];
  readonly sourceId: string;
  readonly title: string;
  readonly chunkText: string;
  readonly createdAt: string;
}

export interface ProjectedEmbeddingPoint {
  readonly id: string;
  readonly originalVector: readonly number[];
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly sourceId: string;
  readonly title: string;
  readonly chunkText: string;
  readonly createdAt: string;
}

export interface BoundingBox3D {
  readonly minX: number;
  readonly maxX: number;
  readonly minY: number;
  readonly maxY: number;
  readonly minZ: number;
  readonly maxZ: number;
}

export interface PcaReductionResult {
  readonly points: readonly ProjectedEmbeddingPoint[];
  /** Variance explained percentage for [PC1, PC2, PC3], e.g. [32.5, 21.4, 14.2] */
  readonly varianceExplained: readonly [number, number, number];
  /** Sum of top 3 variance ratios (0 - 100) */
  readonly totalVarianceRatio: number;
  readonly bounds: BoundingBox3D;
}

export interface NeighborMatch {
  readonly index: number;
  readonly point: ProjectedEmbeddingPoint;
  readonly cosineSimilarity: number;
  readonly cosineDistance: number;
}

/**
 * Calculates dot product between two vectors.
 */
export function dotProduct(a: readonly number[], b: readonly number[]): number {
  const len = Math.min(a.length, b.length);
  let sum = 0;
  for (let i = 0; i < len; i++) {
    sum += a[i] * b[i];
  }
  return sum;
}

/**
 * Calculates Euclidean norm (L2) of a vector.
 */
export function vectorNorm(a: readonly number[]): number {
  let sumSq = 0;
  for (let i = 0; i < a.length; i++) {
    sumSq += a[i] * a[i];
  }
  return Math.sqrt(sumSq);
}

/**
 * Calculates cosine similarity in range [-1, 1].
 */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  const normA = vectorNorm(a);
  const normB = vectorNorm(b);
  if (normA < 1e-12 || normB < 1e-12) return 0;
  const sim = dotProduct(a, b) / (normA * normB);
  return Math.max(-1, Math.min(1, sim));
}

/**
 * Calculates cosine distance in range [0, 2].
 */
export function cosineDistance(a: readonly number[], b: readonly number[]): number {
  return 1 - cosineSimilarity(a, b);
}

/**
 * Finds top K nearest semantic neighbors using cosine similarity on original vectors.
 */
export function findNearestNeighbors(
  targetIdx: number,
  points: readonly ProjectedEmbeddingPoint[],
  topK: number = 3,
): readonly NeighborMatch[] {
  if (targetIdx < 0 || targetIdx >= points.length) return [];
  const target = points[targetIdx];

  const matches: NeighborMatch[] = [];
  for (let i = 0; i < points.length; i++) {
    if (i === targetIdx) continue;
    const sim = cosineSimilarity(target.originalVector, points[i].originalVector);
    matches.push({
      index: i,
      point: points[i],
      cosineSimilarity: sim,
      cosineDistance: 1 - sim,
    });
  }

  matches.sort((a, b) => b.cosineSimilarity - a.cosineSimilarity);
  return matches.slice(0, Math.max(1, topK));
}

/**
 * Power iteration with deflation to find top eigenvectors and eigenvalues of a symmetric N x N matrix.
 */
function powerIterationEigen(
  matrix: Float64Array,
  n: number,
  components: number = 3,
  maxIterations: number = 50,
): { values: number[]; vectors: Float64Array[] } {
  // Work with a copy of matrix to apply deflation
  const a = new Float64Array(matrix);
  const values: number[] = [];
  const vectors: Float64Array[] = [];

  for (let k = 0; k < components; k++) {
    // Pick best initial vector among deterministic candidates to maximize projection on dominant mode
    let bestV = new Float64Array(n);
    let bestRayleigh = -Infinity;

    for (let candidate = 0; candidate < 3; candidate++) {
      const candV = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        candV[i] = Math.sin((i + 1) * (k * 7 + candidate * 3 + 1.6180339887));
      }
      // Orthogonalize against prior eigenvectors
      for (let p = 0; p < k; p++) {
        const prev = vectors[p];
        let dot = 0;
        for (let i = 0; i < n; i++) dot += candV[i] * prev[i];
        for (let i = 0; i < n; i++) candV[i] -= dot * prev[i];
      }
      let cNorm = 0;
      for (let i = 0; i < n; i++) cNorm += candV[i] * candV[i];
      cNorm = Math.sqrt(cNorm);
      if (cNorm > 1e-10) {
        for (let i = 0; i < n; i++) candV[i] /= cNorm;
        let rayleigh = 0;
        for (let i = 0; i < n; i++) {
          let s = 0;
          const rowOffset = i * n;
          for (let j = 0; j < n; j++) s += a[rowOffset + j] * candV[j];
          rayleigh += candV[i] * s;
        }
        if (rayleigh > bestRayleigh) {
          bestRayleigh = rayleigh;
          bestV = candV;
        }
      }
    }

    let v = bestV;

    // Power iterations
    for (let iter = 0; iter < maxIterations; iter++) {
      const nextV = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        let sum = 0;
        const rowOffset = i * n;
        for (let j = 0; j < n; j++) {
          sum += a[rowOffset + j] * v[j];
        }
        nextV[i] = sum;
      }

      // Gram-Schmidt orthogonalization against all previous eigenvectors
      for (let p = 0; p < k; p++) {
        const prev = vectors[p];
        let dot = 0;
        for (let i = 0; i < n; i++) dot += nextV[i] * prev[i];
        for (let i = 0; i < n; i++) nextV[i] -= dot * prev[i];
      }

      let nextNorm = 0;
      for (let i = 0; i < n; i++) nextNorm += nextV[i] * nextV[i];
      nextNorm = Math.sqrt(nextNorm);

      if (nextNorm < 1e-12) {
        break;
      }

      for (let i = 0; i < n; i++) v[i] = nextV[i] / nextNorm;
    }

    // Rayleigh quotient: lambda = v^T * A * v
    let lambda = 0;
    for (let i = 0; i < n; i++) {
      let sum = 0;
      const rowOffset = i * n;
      for (let j = 0; j < n; j++) {
        sum += a[rowOffset + j] * v[j];
      }
      lambda += v[i] * sum;
    }

    if (lambda < 1e-10) {
      lambda = 0;
    }

    values.push(lambda);
    vectors.push(new Float64Array(v));

    // Deflation: A' = A - lambda * (v * v^T)
    if (lambda > 0) {
      for (let i = 0; i < n; i++) {
        const rowOffset = i * n;
        const vi = v[i] * lambda;
        for (let j = 0; j < n; j++) {
          a[rowOffset + j] -= vi * v[j];
        }
      }
    }
  }

  // Sort extracted eigenpairs by eigenvalue descending
  const pairs = values.map((val, idx) => ({ value: val, vector: vectors[idx] }));
  pairs.sort((p1, p2) => p2.value - p1.value);

  return {
    values: pairs.map((p) => p.value),
    vectors: pairs.map((p) => p.vector),
  };
}

/**
 * Projects 768-D (or arbitrary D) embedding vectors into 3D Cartesian space via Dual Gram-matrix PCA.
 *
 * @param items List of embedding records containing `vector` of numbers.
 * @param targetExtent Maximum coordinate magnitude in 3D scene (default 12 units).
 */
export function projectEmbeddingsTo3D(
  items: readonly EmbeddingInputRecord[],
  targetExtent: number = 12,
): PcaReductionResult {
  const n = items.length;
  const emptyBounds: BoundingBox3D = { minX: 0, maxX: 0, minY: 0, maxY: 0, minZ: 0, maxZ: 0 };

  if (n === 0) {
    return {
      points: [],
      varianceExplained: [0, 0, 0],
      totalVarianceRatio: 0,
      bounds: emptyBounds,
    };
  }

  if (n === 1) {
    const singlePoint: ProjectedEmbeddingPoint = {
      id: items[0].id,
      originalVector: items[0].vector,
      x: 0,
      y: 0,
      z: 0,
      sourceId: items[0].sourceId,
      title: items[0].title,
      chunkText: items[0].chunkText,
      createdAt: items[0].createdAt,
    };
    return {
      points: [singlePoint],
      varianceExplained: [100, 0, 0],
      totalVarianceRatio: 100,
      bounds: emptyBounds,
    };
  }

  if (n === 2) {
    const p1: ProjectedEmbeddingPoint = {
      id: items[0].id,
      originalVector: items[0].vector,
      x: -targetExtent / 2,
      y: 0,
      z: 0,
      sourceId: items[0].sourceId,
      title: items[0].title,
      chunkText: items[0].chunkText,
      createdAt: items[0].createdAt,
    };
    const p2: ProjectedEmbeddingPoint = {
      id: items[1].id,
      originalVector: items[1].vector,
      x: targetExtent / 2,
      y: 0,
      z: 0,
      sourceId: items[1].sourceId,
      title: items[1].title,
      chunkText: items[1].chunkText,
      createdAt: items[1].createdAt,
    };
    return {
      points: [p1, p2],
      varianceExplained: [100, 0, 0],
      totalVarianceRatio: 100,
      bounds: { minX: -targetExtent / 2, maxX: targetExtent / 2, minY: 0, maxY: 0, minZ: 0, maxZ: 0 },
    };
  }

  const d = items[0].vector.length;

  // Step 1: Compute mean vector
  const mean = new Float64Array(d);
  for (let i = 0; i < n; i++) {
    const vec = items[i].vector;
    for (let j = 0; j < d; j++) {
      mean[j] += vec[j];
    }
  }
  for (let j = 0; j < d; j++) {
    mean[j] /= n;
  }

  // Step 2: Compute Gram matrix K = X_centered * X_centered^T (N x N)
  // X_centered_i * X_centered_j = dot(v_i - mean, v_j - mean)
  const gram = new Float64Array(n * n);
  let totalTrace = 0;

  for (let i = 0; i < n; i++) {
    const vi = items[i].vector;
    for (let j = i; j < n; j++) {
      const vj = items[j].vector;
      let dot = 0;
      for (let k = 0; k < d; k++) {
        dot += (vi[k] - mean[k]) * (vj[k] - mean[k]);
      }
      gram[i * n + j] = dot;
      gram[j * n + i] = dot;
      if (i === j) {
        totalTrace += dot;
      }
    }
  }

  // Step 3: Extract top 3 eigenvectors and eigenvalues
  const { values, vectors } = powerIterationEigen(gram, n, 3, 40);

  const lambda1 = Math.max(0, values[0] || 0);
  const lambda2 = Math.max(0, values[1] || 0);
  const lambda3 = Math.max(0, values[2] || 0);

  const sqrtL1 = Math.sqrt(lambda1);
  const sqrtL2 = Math.sqrt(lambda2);
  const sqrtL3 = Math.sqrt(lambda3);

  const u1 = vectors[0] || new Float64Array(n);
  const u2 = vectors[1] || new Float64Array(n);
  const u3 = vectors[2] || new Float64Array(n);

  // Raw coordinates: z_{i, k} = sqrt(lambda_k) * u_{k, i}
  const rawX = new Float64Array(n);
  const rawY = new Float64Array(n);
  const rawZ = new Float64Array(n);

  let maxCoord = 0;
  for (let i = 0; i < n; i++) {
    const x = sqrtL1 * u1[i];
    const y = sqrtL2 * u2[i];
    const z = sqrtL3 * u3[i];
    rawX[i] = x;
    rawY[i] = y;
    rawZ[i] = z;
    const absX = Math.abs(x);
    const absY = Math.abs(y);
    const absZ = Math.abs(z);
    if (absX > maxCoord) maxCoord = absX;
    if (absY > maxCoord) maxCoord = absY;
    if (absZ > maxCoord) maxCoord = absZ;
  }

  // Scaling factor to fit targetExtent
  const scale = maxCoord > 1e-8 ? targetExtent / maxCoord : 1;

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;

  const points: ProjectedEmbeddingPoint[] = [];
  for (let i = 0; i < n; i++) {
    const x = Number((rawX[i] * scale).toFixed(4));
    const y = Number((rawY[i] * scale).toFixed(4));
    const z = Number((rawZ[i] * scale).toFixed(4));

    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;

    points.push({
      id: items[i].id,
      originalVector: items[i].vector,
      x,
      y,
      z,
      sourceId: items[i].sourceId,
      title: items[i].title,
      chunkText: items[i].chunkText,
      createdAt: items[i].createdAt,
    });
  }

  // Step 4: Calculate variance explained
  const trace = totalTrace > 1e-12 ? totalTrace : 1;
  const var1 = Number(((lambda1 / trace) * 100).toFixed(1));
  const var2 = Number(((lambda2 / trace) * 100).toFixed(1));
  const var3 = Number(((lambda3 / trace) * 100).toFixed(1));
  const totalVar = Number((var1 + var2 + var3).toFixed(1));

  return {
    points,
    varianceExplained: [var1, var2, var3],
    totalVarianceRatio: Math.min(100, totalVar),
    bounds: {
      minX: Number.isFinite(minX) ? minX : 0,
      maxX: Number.isFinite(maxX) ? maxX : 0,
      minY: Number.isFinite(minY) ? minY : 0,
      maxY: Number.isFinite(maxY) ? maxY : 0,
      minZ: Number.isFinite(minZ) ? minZ : 0,
      maxZ: Number.isFinite(maxZ) ? maxZ : 0,
    },
  };
}
