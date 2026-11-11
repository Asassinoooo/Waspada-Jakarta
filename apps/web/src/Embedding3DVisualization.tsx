import React, { useEffect, useRef, useState, useMemo, useCallback } from "react";
void React;
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import {
  projectEmbeddingsTo3D,
  findNearestNeighbors,
  cosineSimilarity,
  type ProjectedEmbeddingPoint,
  type PcaReductionResult,
  type NeighborMatch,
} from "./embedding-pca.js";
import {
  EmbeddingClientError,
  fetchEmbeddingVisualizationData,
  type EmbeddingVisualizationPayload,
} from "./embedding-client.js";
import { moderatorAccessMessage, SIGN_IN_HREF } from "./account-messages.js";


const SOURCE_COLORS: Readonly<Record<string, number>> = {
  "source-antara-metro": 0x3b82f6, // Royal Blue
  "source-antara-terkini": 0x60a5fa,
  "source-detik-utama": 0xf97316, // Vivid Orange
  "source-detik-news": 0xfb923c,
  "source-cnn-nasional": 0xef4444, // Crimson Red
  "source-cnn-fokus": 0xf87171,
  "source-cnbc-news": 0x10b981, // Emerald Green
  "source-cnbc-market": 0x34d399,
  "source-sindonews-metro": 0xa855f7, // Purple
  "source-sindonews-daerah": 0xc084fc,
  "source-tempo-metro": 0xf59e0b, // Amber
  "source-tempo-nasional": 0xfbbf24,
  "source-bmkg-gempa": 0xeab308, // Gold
  "source-petabencana-reports": 0x06b6d4, // Cyan
};

function getSourceColorHex(sourceId: string): number {
  if (SOURCE_COLORS[sourceId]) return SOURCE_COLORS[sourceId];
  if (sourceId.includes("antara")) return 0x3b82f6;
  if (sourceId.includes("detik")) return 0xf97316;
  if (sourceId.includes("cnn")) return 0xef4444;
  if (sourceId.includes("cnbc")) return 0x10b981;
  if (sourceId.includes("sindonews")) return 0xa855f7;
  if (sourceId.includes("tempo")) return 0xf59e0b;
  if (sourceId.includes("bmkg")) return 0xeab308;
  if (sourceId.includes("petabencana")) return 0x06b6d4;
  return 0x94a3b8;
}

// Reads a CSS custom property as a three.js colour; falls back when unset or unparsable.
function readCssColor(name: string, fallback: number): number {
  try {
    const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return value ? new THREE.Color(value).getHex() : fallback;
  } catch {
    return fallback;
  }
}

function getSourceColorCss(sourceId: string): string {
  const hex = getSourceColorHex(sourceId);
  return "#" + hex.toString(16).padStart(6, "0");
}

function formatWibDate(isoDate: string): string {
  try {
    return new Intl.DateTimeFormat("id-ID", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: "Asia/Jakarta",
    }).format(new Date(isoDate)) + " WIB";
  } catch {
    return isoDate;
  }
}

export function Embedding3DVisualization() {
  const [dataPayload, setDataPayload] = useState<EmbeddingVisualizationPayload | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  // 401/403 from the server means the visualization is moderator-only; it is not a transport failure.
  const [accessMessage, setAccessMessage] = useState<string | null>(null);

  // Filters and Interactivity State
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [selectedSource, setSelectedSource] = useState<string>("all");
  const [selectedPointIndex, setSelectedPointIndex] = useState<number | null>(null);
  const [autoRotate, setAutoRotate] = useState<boolean>(false);
  const [showClusterLines, setShowClusterLines] = useState<boolean>(true);
  const [hoveredInfo, setHoveredInfo] = useState<{
    point: ProjectedEmbeddingPoint;
    screenX: number;
    screenY: number;
  } | null>(null);
  useEffect(() => {
    void import("./embedding-3d.css");
  }, []);

  // Refs for 3D elements
  const canvasMountRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const spheresGroupRef = useRef<THREE.Group | null>(null);
  const linesGroupRef = useRef<THREE.Group | null>(null);
  const animFrameIdRef = useRef<number | null>(null);

  // Fetch embedding data
  useEffect(() => {
    let active = true;
    const abortCtrl = new AbortController();

    async function load() {
      try {
        setLoading(true);
        setErrorMessage(null);
        setAccessMessage(null);
        const data = await fetchEmbeddingVisualizationData({ limit: 300, signal: abortCtrl.signal });
        if (active) {
          setDataPayload(data);
        }
      } catch (err) {
        if (active && !(err instanceof DOMException && err.name === "AbortError")) {
          const denied = err instanceof EmbeddingClientError ? moderatorAccessMessage(err.status ?? null) : null;
          if (denied !== null) {
            setAccessMessage(denied);
          } else {
            setErrorMessage(err instanceof Error ? err.message : String(err));
          }
        }
      } finally {
        if (active) {
          setLoading(false);
        }
      }
    }

    load();
    return () => {
      active = false;
      abortCtrl.abort();
    };
  }, []);

  // Compute 3D PCA Projection
  const pcaResult: PcaReductionResult = useMemo(() => {
    if (!dataPayload || dataPayload.items.length === 0) {
      return {
        points: [],
        varianceExplained: [0, 0, 0],
        totalVarianceRatio: 0,
        bounds: { minX: 0, maxX: 0, minY: 0, maxY: 0, minZ: 0, maxZ: 0 },
      };
    }

    const inputRecords = dataPayload.items.map((item, idx) => ({
      id: item.chunkId || `chunk-${idx}`,
      vector: item.vector,
      sourceId: item.sourceId,
      title: item.title,
      chunkText: item.chunkText,
      createdAt: item.createdAt,
    }));

    return projectEmbeddingsTo3D(inputRecords, 14);
  }, [dataPayload]);

  // Unique list of sources for filter dropdown
  const uniqueSources = useMemo(() => {
    if (!dataPayload) return [];
    const set = new Set<string>();
    for (const item of dataPayload.items) {
      set.add(item.sourceId);
    }
    return Array.from(set).sort();
  }, [dataPayload]);

  // Selected point details
  const selectedPoint = useMemo(() => {
    if (selectedPointIndex === null || !pcaResult.points[selectedPointIndex]) return null;
    return pcaResult.points[selectedPointIndex];
  }, [selectedPointIndex, pcaResult.points]);

  // Top 3 nearest neighbors of selected point
  const nearestNeighbors: readonly NeighborMatch[] = useMemo(() => {
    if (selectedPointIndex === null || pcaResult.points.length <= 1) return [];
    return findNearestNeighbors(selectedPointIndex, pcaResult.points, 3);
  }, [selectedPointIndex, pcaResult.points]);

  // Reset Camera View Handler
  const handleResetCamera = useCallback(() => {
    if (cameraRef.current && controlsRef.current) {
      cameraRef.current.position.set(0, 15, 32);
      controlsRef.current.target.set(0, 0, 0);
      controlsRef.current.update();
    }
  }, []);

  // Initialize Three.js WebGL Scene
  useEffect(() => {
    const container = canvasMountRef.current;
    if (!container || pcaResult.points.length === 0) return;

    // Detect WebGL capability safely
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: "high-performance" });
    } catch {
      // Fallback: WebGL not supported in this environment
      return;
    }

    renderer.setSize(container.clientWidth, container.clientHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setClearColor(readCssColor("--viz-stage", 0x0b1120), 1);
    container.innerHTML = "";
    container.appendChild(renderer.domElement);
    rendererRef.current = renderer;

    const scene = new THREE.Scene();
    sceneRef.current = scene;

    const camera = new THREE.PerspectiveCamera(
      50,
      container.clientWidth / Math.max(1, container.clientHeight),
      0.1,
      1000,
    );
    camera.position.set(0, 15, 32);
    cameraRef.current = camera;

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.05;
    controls.minDistance = 4;
    controls.maxDistance = 90;
    controls.autoRotate = autoRotate;
    controls.autoRotateSpeed = 1.0;
    controlsRef.current = controls;

    // Lighting
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.9);
    scene.add(ambientLight);

    const dirLight = new THREE.DirectionalLight(0xffffff, 1.2);
    dirLight.position.set(20, 30, 20);
    scene.add(dirLight);

    const dirLightBack = new THREE.DirectionalLight(0x93c5fd, 0.6);
    dirLightBack.position.set(-20, -10, -20);
    scene.add(dirLightBack);

    // Coordinate Grid at floor
    const gridHelper = new THREE.GridHelper(30, 30, 0x334155, 0x1e293b);
    gridHelper.position.y = -14;
    scene.add(gridHelper);

    // 3D Axis indicator lines
    const axisGroup = new THREE.Group();
    const axisLength = 16;
    // PC1: X (Red/Coral)
    const pc1Geom = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(-axisLength, 0, 0), new THREE.Vector3(axisLength, 0, 0)]);
    axisGroup.add(new THREE.Line(pc1Geom, new THREE.LineBasicMaterial({ color: 0xf43f5e, transparent: true, opacity: 0.3 })));
    // PC2: Y (Emerald Green)
    const pc2Geom = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, -axisLength, 0), new THREE.Vector3(0, axisLength, 0)]);
    axisGroup.add(new THREE.Line(pc2Geom, new THREE.LineBasicMaterial({ color: 0x10b981, transparent: true, opacity: 0.3 })));
    // PC3: Z (Sky Blue)
    const pc3Geom = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, -axisLength), new THREE.Vector3(0, 0, axisLength)]);
    axisGroup.add(new THREE.Line(pc3Geom, new THREE.LineBasicMaterial({ color: 0x38bdf8, transparent: true, opacity: 0.3 })));
    scene.add(axisGroup);

    // Spheres group
    const spheresGroup = new THREE.Group();
    spheresGroupRef.current = spheresGroup;
    scene.add(spheresGroup);

    const sphereGeom = new THREE.SphereGeometry(0.48, 16, 16);

    for (let i = 0; i < pcaResult.points.length; i++) {
      const pt = pcaResult.points[i];
      const color = getSourceColorHex(pt.sourceId);
      const mat = new THREE.MeshStandardMaterial({
        color,
        roughness: 0.3,
        metalness: 0.2,
      });
      const mesh = new THREE.Mesh(sphereGeom, mat);
      mesh.position.set(pt.x, pt.y, pt.z);
      mesh.userData = { index: i, point: pt };
      spheresGroup.add(mesh);
    }

    // Cluster Connection Lines (for pairs with cosine similarity >= 0.75)
    const linesGroup = new THREE.Group();
    linesGroupRef.current = linesGroup;
    scene.add(linesGroup);

    const linePoints: THREE.Vector3[] = [];
    const n = pcaResult.points.length;
    for (let i = 0; i < n; i++) {
      const pi = pcaResult.points[i];
      for (let j = i + 1; j < n; j++) {
        const pj = pcaResult.points[j];
        const sim = cosineSimilarity(pi.originalVector, pj.originalVector);
        if (sim >= 0.75) {
          linePoints.push(new THREE.Vector3(pi.x, pi.y, pi.z));
          linePoints.push(new THREE.Vector3(pj.x, pj.y, pj.z));
        }
      }
    }

    if (linePoints.length > 0) {
      const lineGeom = new THREE.BufferGeometry().setFromPoints(linePoints);
      const lineMat = new THREE.LineBasicMaterial({
        color: 0x06b6d4,
        transparent: true,
        opacity: 0.25,
      });
      linesGroup.add(new THREE.LineSegments(lineGeom, lineMat));
    }
    linesGroup.visible = showClusterLines;

    // Raycaster for mouse interaction
    const raycaster = new THREE.Raycaster();
    const mouse = new THREE.Vector2();

    const handlePointerMove = (e: MouseEvent) => {
      const rect = renderer.domElement.getBoundingClientRect();
      mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

      raycaster.setFromCamera(mouse, camera);
      const intersects = raycaster.intersectObjects(spheresGroup.children);

      if (intersects.length > 0) {
        const hit = intersects[0].object as THREE.Mesh;
        const pt = hit.userData?.point as ProjectedEmbeddingPoint;
        if (pt) {
          setHoveredInfo({
            point: pt,
            screenX: e.clientX - rect.left,
            screenY: e.clientY - rect.top,
          });
        }
      } else {
        setHoveredInfo(null);
      }
    };

    const handlePointerDown = (e: MouseEvent) => {
      const rect = renderer.domElement.getBoundingClientRect();
      mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

      raycaster.setFromCamera(mouse, camera);
      const intersects = raycaster.intersectObjects(spheresGroup.children);

      if (intersects.length > 0) {
        const hit = intersects[0].object as THREE.Mesh;
        const idx = hit.userData?.index;
        if (typeof idx === "number") {
          setSelectedPointIndex(idx);
        }
      }
    };

    const domElem = renderer.domElement;
    domElem.addEventListener("mousemove", handlePointerMove);
    domElem.addEventListener("click", handlePointerDown);

    // Resize observer
    const handleResize = () => {
      if (!container || !rendererRef.current || !cameraRef.current) return;
      const width = container.clientWidth;
      const height = container.clientHeight;
      cameraRef.current.aspect = width / Math.max(1, height);
      cameraRef.current.updateProjectionMatrix();
      rendererRef.current.setSize(width, height);
    };

    window.addEventListener("resize", handleResize);

    // Animation Loop
    let isRunning = true;
    const animate = () => {
      if (!isRunning) return;
      animFrameIdRef.current = requestAnimationFrame(animate);
      controls.update();
      renderer.render(scene, camera);
    };
    animate();

    return () => {
      isRunning = false;
      if (animFrameIdRef.current !== null) {
        cancelAnimationFrame(animFrameIdRef.current);
      }
      window.removeEventListener("resize", handleResize);
      domElem.removeEventListener("mousemove", handlePointerMove);
      domElem.removeEventListener("click", handlePointerDown);
      controls.dispose();
      renderer.dispose();
      container.innerHTML = "";
    };
  }, [pcaResult.points]);

  // Update Auto-rotate in controls when state changes
  useEffect(() => {
    if (controlsRef.current) {
      controlsRef.current.autoRotate = autoRotate;
    }
  }, [autoRotate]);

  // Update cluster lines visibility
  useEffect(() => {
    if (linesGroupRef.current) {
      linesGroupRef.current.visible = showClusterLines;
    }
  }, [showClusterLines]);

  // Update meshes appearance on filter or selection change
  useEffect(() => {
    if (!spheresGroupRef.current) return;

    const query = searchQuery.trim().toLowerCase();
    const children = spheresGroupRef.current.children as THREE.Mesh[];

    for (const mesh of children) {
      const pt = mesh.userData?.point as ProjectedEmbeddingPoint;
      const idx = mesh.userData?.index as number;
      if (!pt) continue;

      const matchesSearch = query.length === 0 ||
        pt.title.toLowerCase().includes(query) ||
        pt.chunkText.toLowerCase().includes(query);
      const matchesSource = selectedSource === "all" || pt.sourceId === selectedSource;
      const isVisible = matchesSearch && matchesSource;
      const isSelected = idx === selectedPointIndex;

      const mat = mesh.material as THREE.MeshStandardMaterial;

      if (!isVisible) {
        mat.transparent = true;
        mat.opacity = 0.15;
        mesh.scale.set(0.6, 0.6, 0.6);
        mat.emissive.setHex(0x000000);
      } else if (isSelected) {
        mat.transparent = false;
        mat.opacity = 1.0;
        mesh.scale.set(1.5, 1.5, 1.5);
        mat.emissive.setHex(0x38bdf8);
      } else {
        mat.transparent = false;
        mat.opacity = 1.0;
        mesh.scale.set(1.0, 1.0, 1.0);
        mat.emissive.setHex(0x000000);
      }
    }
  }, [searchQuery, selectedSource, selectedPointIndex]);

  return (
    <main className="embedding-3d" aria-label="Visualisasi 3D Embedding Potongan Teks">
      {/* Header and Context Metadata */}
      <header className="embedding-3d__header">
        <div className="embedding-3d__title-group">
          <h1>Visualisasi 3D Embedding Potongan Teks</h1>
          <p className="embedding-3d__subtitle">
            Proyeksi vektor 768-dimensi (NineRouter Gemini Embedding) ke ruang 3D melalui Dual Gram-Matrix PCA.
          </p>
        </div>
        <div className="embedding-3d__meta-badges">
          <span className={`embedding-3d__badge ${dataPayload?.datasetKind === "live" ? "embedding-3d__badge--live" : ""}`}>
            Dataset: {dataPayload?.datasetKind === "live" ? "Live Postgres" : "Demo Fiktif"}
          </span>
          <span className="embedding-3d__badge embedding-3d__badge--pca">
            PCA 768D → 3D
          </span>
          <span className="embedding-3d__badge">
            {pcaResult.points.length} Chunk
          </span>
        </div>
      </header>

      {/* Control Toolbar */}
      <section className="embedding-3d__toolbar" aria-label="Alat dan Penyaring 3D">
        <div className="embedding-3d__filter-group">
          <input
            type="search"
            className="embedding-3d__search-input"
            placeholder="Cari kata kunci dalam teks chunk…"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            aria-label="Pencarian chunk teks"
          />
          <select
            className="embedding-3d__source-select"
            value={selectedSource}
            onChange={(e) => setSelectedSource(e.target.value)}
            aria-label="Saring berdasarkan sumber"
          >
            <option value="all">Semua Sumber ({pcaResult.points.length})</option>
            {uniqueSources.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        </div>

        <div className="embedding-3d__action-group">
          <button
            type="button"
            className={`embedding-3d__btn ${autoRotate ? "embedding-3d__btn--active" : ""}`}
            onClick={() => setAutoRotate(!autoRotate)}
            aria-label="Putar kamera otomatis"
          >
            {autoRotate ? "⏹ Hentikan Putar" : "⟳ Putar Otomatis"}
          </button>
          <button
            type="button"
            className={`embedding-3d__btn ${showClusterLines ? "embedding-3d__btn--active" : ""}`}
            onClick={() => setShowClusterLines(!showClusterLines)}
            aria-label="Tampilkan garis klaster semantik"
          >
            {showClusterLines ? "Sembunyikan Garis Klaster" : "Garis Klaster (≥0.75)"}
          </button>
          <button
            type="button"
            className="embedding-3d__btn"
            onClick={handleResetCamera}
            aria-label="Atur ulang posisi kamera"
          >
            Reset Kamera
          </button>
        </div>
      </section>

      {/* Loading or Error State */}
      {loading && (
        <section className="state-panel" aria-busy="true">
          <p>Memuat vektor embedding dari pipeline…</p>
        </section>
      )}

      {accessMessage && (
        <section className="state-panel" role="status">
          <p>{accessMessage}</p>
          <a className="text-link" href={SIGN_IN_HREF}>Masuk dengan username</a>
        </section>
      )}

      {errorMessage && (
        <section className="state-panel state-panel--error" role="alert">
          <p>Terjadi kesalahan saat memuat visualisasi: {errorMessage}</p>
        </section>
      )}

      {/* 3D Workspace */}
      {!loading && (
        <div className={`embedding-3d__workspace ${selectedPoint ? "embedding-3d__workspace--with-inspector" : ""}`}>
          <div className="embedding-3d__canvas-container">
            <div ref={canvasMountRef} className="embedding-3d__canvas" tabIndex={0} aria-label="Kanvas 3D WebGL interaktif" />

            {/* HUD Overlay with Variance Metrics */}
            <div className="embedding-3d__hud">
              <div className="embedding-3d__hud-card">
                <strong>Variansi Terjelaskan (PCA):</strong>
                <div className="embedding-3d__hud-metrics">
                  <span>PC1 (X): <strong>{pcaResult.varianceExplained[0]}%</strong></span>
                  <span>PC2 (Y): <strong>{pcaResult.varianceExplained[1]}%</strong></span>
                  <span>PC3 (Z): <strong>{pcaResult.varianceExplained[2]}%</strong></span>
                  <span>Total: <strong>{pcaResult.totalVarianceRatio}%</strong></span>
                </div>
              </div>
            </div>

            {/* Color Legend */}
            <div className="embedding-3d__legend">
              {uniqueSources.slice(0, 7).map((s) => (
                <span key={s} className="embedding-3d__legend-item">
                  <span className="embedding-3d__legend-dot" style={{ backgroundColor: getSourceColorCss(s) }} />
                  <span>{s.replace("source-", "")}</span>
                </span>
              ))}
              {uniqueSources.length > 7 && (
                <span className="embedding-3d__legend-item">+{uniqueSources.length - 7} lainnya</span>
              )}
            </div>

            {/* Hover Tooltip */}
            {hoveredInfo && (
              <div
                className="embedding-3d__tooltip"
                style={{ left: `${hoveredInfo.screenX}px`, top: `${hoveredInfo.screenY}px` }}
              >
                <div className="embedding-3d__tooltip-title">{hoveredInfo.point.title}</div>
                <div className="embedding-3d__tooltip-source">{hoveredInfo.point.sourceId}</div>
              </div>
            )}
          </div>

          {/* Side Inspector Panel for Selected Chunk */}
          {selectedPoint && (
            <aside className="embedding-3d__inspector" aria-label="Rincian Chunk Terpilih">
              <div className="embedding-3d__inspector-header">
                <div>
                  <span
                    className="embedding-3d__badge"
                    style={{ borderColor: getSourceColorCss(selectedPoint.sourceId), color: getSourceColorCss(selectedPoint.sourceId) }}
                  >
                    {selectedPoint.sourceId}
                  </span>
                  <h3>{selectedPoint.title}</h3>
                </div>
                <button
                  type="button"
                  className="embedding-3d__close-btn"
                  onClick={() => setSelectedPointIndex(null)}
                  aria-label="Tutup panel rincian"
                >
                  ✕
                </button>
              </div>

              <time dateTime={selectedPoint.createdAt} style={{ fontSize: "var(--text-sm)", color: "var(--color-text-muted)" }}>
                Waktu: {formatWibDate(selectedPoint.createdAt)}
              </time>

              <blockquote className="embedding-3d__inspector-chunk-quote">
                &ldquo;{selectedPoint.chunkText}&rdquo;
              </blockquote>

              <div className="embedding-3d__coords-box">
                <span>PC1(X): {selectedPoint.x.toFixed(2)}</span>
                <span>PC2(Y): {selectedPoint.y.toFixed(2)}</span>
                <span>PC3(Z): {selectedPoint.z.toFixed(2)}</span>
              </div>

              {/* Nearest Semantic Neighbors */}
              <div className="embedding-3d__neighbors-section">
                <h4>Tetangga Semantik Terdekat (Cosine Similarity)</h4>
                {nearestNeighbors.map((match) => (
                  <div
                    key={match.point.id}
                    className="embedding-3d__neighbor-item"
                    onClick={() => setSelectedPointIndex(match.index)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => { if (e.key === "Enter") setSelectedPointIndex(match.index); }}
                    aria-label={`Pilih tetangga ${match.point.title}`}
                  >
                    <div className="embedding-3d__neighbor-header">
                      <span style={{ color: getSourceColorCss(match.point.sourceId), fontWeight: "var(--weight-semibold)" }}>
                        {match.point.sourceId}
                      </span>
                      <span className="embedding-3d__neighbor-sim">
                        {(match.cosineSimilarity * 100).toFixed(1)}% kemiripan
                      </span>
                    </div>
                    <div className="embedding-3d__neighbor-title">{match.point.title}</div>
                  </div>
                ))}
              </div>
            </aside>
          )}
        </div>
      )}

      {/* Accessible Non-WebGL Fallback List */}
      <section className="sr-only" aria-label="Daftar Data Koordinat Embedding 3D">
        <h2>Daftar Vektor Chunk Terproyeksi</h2>
        <table className="embedding-3d__fallback-table">
          <thead>
            <tr>
              <th>Sumber</th>
              <th>Judul</th>
              <th>PC1 (X)</th>
              <th>PC2 (Y)</th>
              <th>PC3 (Z)</th>
            </tr>
          </thead>
          <tbody>
            {pcaResult.points.map((p) => (
              <tr key={p.id}>
                <td>{p.sourceId}</td>
                <td>{p.title}</td>
                <td>{p.x}</td>
                <td>{p.y}</td>
                <td>{p.z}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </main>
  );
}
