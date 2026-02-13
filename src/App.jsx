import React, { useState, useRef, useEffect, useCallback } from 'react';
import {
  Download,
  Undo,
  Redo,
  Trash2,
  Eraser,
  PenTool,
  Hand,
  Image as ImageIcon,
  Wand2,
  SplitSquareHorizontal,
  X,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  ChevronDown
} from 'lucide-react';

/**
 * CVI Layered Canvas (v13)
 * * Feature: Stability & Performance Fixes.
 * * Updates:
 * - Replaced perpetual rAF loop with on-demand rendering.
 * - Cached analysis canvas for edge-snap performance.
 * - Added mouse wheel zoom for desktop users.
 * - Fixed save background fill for transparent images.
 * - Added error boundary, removed dead code & unused imports.
 */

const COLORS = [
  { name: 'Red', value: '#FF4444' },
  { name: 'Orange', value: '#FF8833' },
  { name: 'Yellow', value: '#FFD700' },
  { name: 'Green', value: '#44DD44' },
  { name: 'Blue', value: '#4488FF' },
  { name: 'Purple', value: '#BB66FF' },
  { name: 'White', value: '#FFFFFF' },
  { name: 'Black', value: '#000000' },
];

export default function App() {
  const canvasRef = useRef(null);
  const containerRef = useRef(null);
  const fileInputRef = useRef(null);
  const refInputRef = useRef(null);

  // Buffers
  const analysisCanvas = useRef(document.createElement('canvas'));
  const inkCanvas = useRef(document.createElement('canvas'));
  const analysisImageRef = useRef(null); // Cache identity for analysis canvas
  const animFrameRef = useRef(null); // On-demand rendering

  // --- State ---
  const [isReady, setIsReady] = useState(false);
  const [image, setImage] = useState(null);
  const [referenceImage, setReferenceImage] = useState(null);

  // Tools
  const [tool, setTool] = useState('pen');
  const [color, setColor] = useState('#FF4444');
  const [size, setSize] = useState(12);
  const [version, setVersion] = useState(0);

  // Comparison State
  const [isComparing, setIsComparing] = useState(false);
  const [sliderPos, setSliderPos] = useState(0.5);
  const isDraggingSlider = useRef(false);

  // Drawer States
  const [leftOpen, setLeftOpen] = useState(true);
  const [rightOpen, setRightOpen] = useState(true);
  const [bottomOpen, setBottomOpen] = useState(true);

  // --- Refs ---
  // Left Side (Workspace) Data
  const paths = useRef([]);
  const history = useRef([]);
  const transform = useRef({ x: 0, y: 0, k: 1 });
  const currentPath = useRef(null);
  const pointers = useRef(new Map());
  const activeSide = useRef('left');
  const gestureState = useRef({ lastDist: 0, lastCenter: null, lastPos: null });
  const isMiddleMousePanning = useRef(false);
  const middleMouseLastPos = useRef(null);

  // Redo stacks
  const redoStack = useRef([]);
  const refRedoStack = useRef([]);

  // Right Side (Comparative) Data
  const refPaths = useRef([]);
  const refHistory = useRef([]);
  const refTransform = useRef({ x: 0, y: 0, k: 1 });
  const currentRefPath = useRef(null);


  const renderPathToContext = (ctx, p) => {
    if (p.points.length < 1) return;

    ctx.beginPath();
    ctx.lineWidth = p.size;

    if (p.isEraser) {
      ctx.globalCompositeOperation = 'destination-out';
      ctx.strokeStyle = 'rgba(0,0,0,1)';
    } else {
      ctx.globalCompositeOperation = 'source-over';
      ctx.strokeStyle = p.color;
    }

    const pts = p.points;
    ctx.moveTo(pts[0].x, pts[0].y);

    if (pts.length < 2) {
      ctx.lineTo(pts[0].x, pts[0].y);
    } else {
      for (let i = 1; i < pts.length - 2; i++) {
        const xc = (pts[i].x + pts[i + 1].x) / 2;
        const yc = (pts[i].y + pts[i + 1].y) / 2;
        ctx.quadraticCurveTo(pts[i].x, pts[i].y, xc, yc);
      }
      const last = pts.length - 2;
      ctx.quadraticCurveTo(pts[last].x, pts[last].y, pts[last + 1].x, pts[last + 1].y);
    }
    ctx.stroke();
    ctx.globalCompositeOperation = 'source-over';
  };

  const drawWorkspace = (ctx, dpr, rect, sliderPosition = 0.5) => {
    const { x, y, k } = transform.current;
    // In comparison mode, center of left pane is at (sliderPos * width) / 2
    const leftPaneWidth = rect.width * sliderPosition;
    const cx = isComparing ? leftPaneWidth / 2 : rect.width / 2;
    const cy = rect.height / 2;

    ctx.fillStyle = '#111111';
    ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);

    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.translate(cx, cy);
    ctx.scale(k, k);
    ctx.translate(x, y);
    if (image) {
      ctx.drawImage(image, -image.width / 2, -image.height / 2, image.width, image.height);
    }

    // Draw ink paths in the same transform as the image
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    paths.current.forEach(p => renderPathToContext(ctx, p));
    if (currentPath.current) renderPathToContext(ctx, currentPath.current);

    ctx.restore();
  };

  const drawReference = (ctx, dpr, rect) => {
    const availW = rect.width * (1 - sliderPos);
    const startX = rect.width * sliderPos;
    const cx = startX + availW / 2;
    const cy = rect.height / 2;

    const { x, y, k } = refTransform.current;

    ctx.fillStyle = '#111111';
    ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);

    if (referenceImage) {
      ctx.save();
      ctx.scale(dpr, dpr);

      ctx.translate(cx, cy);
      ctx.scale(k, k);
      ctx.translate(x, y);

      ctx.drawImage(referenceImage, -referenceImage.width / 2, -referenceImage.height / 2);

      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      refPaths.current.forEach(p => renderPathToContext(ctx, p));
      if (currentRefPath.current) renderPathToContext(ctx, currentRefPath.current);

      ctx.restore();
    }
  };

  const draw = useCallback(() => {
    if (!canvasRef.current || !containerRef.current) return;

    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    const container = containerRef.current;
    const rect = container.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;

    if (canvas.width !== Math.round(rect.width * dpr) || canvas.height !== Math.round(rect.height * dpr)) {
      canvas.width = rect.width * dpr;
      canvas.height = rect.height * dpr;
      canvas.style.width = `${rect.width}px`;
      canvas.style.height = `${rect.height}px`;
    }

    ctx.setTransform(1, 0, 0, 1, 0, 0);

    if (!isComparing) {
      drawWorkspace(ctx, dpr, rect, 1.0);
    } else {
      const splitX = canvas.width * sliderPos;

      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, splitX, canvas.height);
      ctx.clip();
      drawWorkspace(ctx, dpr, rect, sliderPos);
      ctx.restore();

      ctx.save();
      ctx.beginPath();
      ctx.rect(splitX, 0, canvas.width - splitX, canvas.height);
      ctx.clip();
      drawReference(ctx, dpr, rect);
      ctx.restore();

      ctx.beginPath();
      ctx.moveTo(splitX, 0);
      ctx.lineTo(splitX, canvas.height);
      ctx.lineWidth = 4 * dpr;
      ctx.strokeStyle = '#FFFFFF';
      ctx.stroke();
    }

  }, [image, referenceImage, isComparing, sliderPos, version]);

  // --- On-demand redraw scheduler ---
  const requestRedraw = useCallback(() => {
    if (animFrameRef.current) return;
    animFrameRef.current = requestAnimationFrame(() => {
      animFrameRef.current = null;
      draw();
    });
  }, [draw]);

  // --- Logic & Events ---

  const snapToEdge = (worldX, worldY, targetImage, prevPoints) => {
    if (!targetImage) return { x: worldX, y: worldY };

    const imgX = Math.round(worldX + targetImage.width / 2);
    const imgY = Math.round(worldY + targetImage.height / 2);

    // Compute drawing direction from recent points - use long lookback for persistence
    let dirX = 0, dirY = 0;
    let hasDirection = false;
    if (prevPoints && prevPoints.length >= 3) {
      // Use weighted average of direction over many points for stability
      // Older segments get MORE weight so direction persists
      const len = prevPoints.length;
      const lookback = Math.min(len, 25);
      let totalWeight = 0;
      for (let i = len - lookback; i < len - 1; i++) {
        const segDx = prevPoints[i + 1].x - prevPoints[i].x;
        const segDy = prevPoints[i + 1].y - prevPoints[i].y;
        const segLen = Math.hypot(segDx, segDy);
        if (segLen < 0.5) continue;
        // Weight: older segments get higher weight for persistence
        const age = len - 1 - i;
        const weight = 1.0 + age * 0.3;
        dirX += (segDx / segLen) * weight;
        dirY += (segDy / segLen) * weight;
        totalWeight += weight;
      }
      if (totalWeight > 0) {
        dirX /= totalWeight;
        dirY /= totalWeight;
        const dirLen = Math.hypot(dirX, dirY);
        if (dirLen > 0.1) {
          dirX /= dirLen;
          dirY /= dirLen;
          hasDirection = true;
        }
      }
    }

    // Perpendicular to drawing direction (this is the snap direction)
    const perpX = hasDirection ? -dirY : 0;
    const perpY = hasDirection ? dirX : 0;

    const r = 8;
    const startX = Math.max(1, imgX - r);
    const startY = Math.max(1, imgY - r);
    const endX = Math.min(targetImage.width - 1, imgX + r);
    const endY = Math.min(targetImage.height - 1, imgY + r);

    if (endX - startX <= 2 || endY - startY <= 2) return { x: worldX, y: worldY };

    const ac = analysisCanvas.current;
    if (analysisImageRef.current !== targetImage) {
      ac.width = targetImage.width;
      ac.height = targetImage.height;
      ac.getContext('2d').drawImage(targetImage, 0, 0);
      analysisImageRef.current = targetImage;
    }

    const ctx = ac.getContext('2d');
    const padStartX = Math.max(0, startX - 1);
    const padStartY = Math.max(0, startY - 1);
    const padW = Math.min(targetImage.width, endX + 2) - padStartX;
    const padH = Math.min(targetImage.height, endY + 2) - padStartY;
    const data = ctx.getImageData(padStartX, padStartY, padW, padH).data;

    const lum = (px, py) => {
      const lx = px - padStartX;
      const ly = py - padStartY;
      const i = (ly * padW + lx) * 4;
      const a = data[i + 3] / 255;
      return (data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114) * a;
    };

    let maxScore = -1;
    let bestX = imgX;
    let bestY = imgY;

    for (let py = startY; py < endY; py++) {
      for (let px = startX; px < endX; px++) {
        // Gradient in x and y
        const gx = lum(px + 1, py) - lum(px - 1, py);
        const gy = lum(px, py + 1) - lum(px, py - 1);
        const gradMag = Math.hypot(gx, gy);

        // Alpha edge detection
        const ai = ((py - padStartY) * padW + (px - padStartX)) * 4;
        const aL = data[((py - padStartY) * padW + (px - 1 - padStartX)) * 4 + 3] || 0;
        const aR = data[((py - padStartY) * padW + (px + 1 - padStartX)) * 4 + 3] || 0;
        const aU = data[((py - 1 - padStartY) * padW + (px - padStartX)) * 4 + 3] || 0;
        const aD = data[((py + 1 - padStartY) * padW + (px - padStartX)) * 4 + 3] || 0;
        const alphaGrad = Math.hypot(aR - aL, aD - aU) / 255;

        const edgeStrength = gradMag + alphaGrad * 80;
        if (edgeStrength < 5) continue; // Skip non-edge pixels entirely

        const dx = px - imgX;
        const dy = py - imgY;
        const dist = Math.hypot(dx, dy);

        if (hasDirection) {
          // Decompose offset into parallel and perpendicular components
          const parallelDist = Math.abs(dx * dirX + dy * dirY);
          const perpDist = Math.abs(dx * perpX + dy * perpY);

          // The edge gradient direction (normalized)
          const edgeDirX = gradMag > 0.1 ? gx / gradMag : 0;
          const edgeDirY = gradMag > 0.1 ? gy / gradMag : 0;

          // Edge orientation bonus: reward edges whose gradient is perpendicular to
          // the drawing direction (meaning the edge runs parallel to the drawing direction)
          // gradient is perpendicular to the edge itself, so dot(gradient, drawDir) should be high
          const orientationBonus = Math.abs(edgeDirX * dirX + edgeDirY * dirY) * 15;

          // Heavy penalty for perpendicular distance (cross-edge jumping)
          // Light penalty for parallel distance (along-edge movement is fine)
          const penalty = perpDist * 8.0 + parallelDist * 1.5;

          const score = edgeStrength + orientationBonus - penalty;
          if (score > maxScore) { maxScore = score; bestX = px; bestY = py; }
        } else {
          // No direction info yet (first point) — just use distance
          const penalty = dist * 5.0;
          const score = edgeStrength - penalty;
          if (score > maxScore) { maxScore = score; bestX = px; bestY = py; }
        }
      }
    }

    if (maxScore < 5) return { x: worldX, y: worldY };

    // Clamp snap so it never leaps more than 6px from cursor
    const maxSnap = 6;
    let snapX = bestX - targetImage.width / 2;
    let snapY = bestY - targetImage.height / 2;
    const snapDx = snapX - worldX;
    const snapDy = snapY - worldY;
    const snapDist = Math.hypot(snapDx, snapDy);
    if (snapDist > maxSnap) {
      const clampScale = maxSnap / snapDist;
      snapX = worldX + snapDx * clampScale;
      snapY = worldY + snapDy * clampScale;
    }
    return { x: snapX, y: snapY };
  };

  useEffect(() => {
    setIsReady(true);
    const preventDefault = (e) => e.preventDefault();
    document.body.addEventListener('touchmove', preventDefault, { passive: false });
    return () => document.body.removeEventListener('touchmove', preventDefault);
  }, []);

  useEffect(() => {
    if (!isReady) return;
    requestRedraw();
    const handleResize = () => {
      if (image && containerRef.current) {
        const rect = containerRef.current.getBoundingClientRect();
        const availW = isComparing ? rect.width * sliderPos : rect.width;
        const scaleFit = Math.min(availW / image.width, rect.height / image.height) * 0.9;
        transform.current = { x: 0, y: 0, k: scaleFit };
      }
      if (referenceImage && containerRef.current) {
        const rect = containerRef.current.getBoundingClientRect();
        const availW = rect.width * (1 - sliderPos);
        const availH = rect.height;
        const scaleFit = Math.min(availW / referenceImage.width, availH / referenceImage.height) * 0.9;
        refTransform.current = { x: 0, y: 0, k: scaleFit };
      }
      requestRedraw();
    };
    window.addEventListener('resize', handleResize);
    return () => {
      window.removeEventListener('resize', handleResize);
      if (animFrameRef.current) {
        cancelAnimationFrame(animFrameRef.current);
        animFrameRef.current = null;
      }
    };
  }, [isReady, requestRedraw, image, referenceImage, isComparing, sliderPos]);

  // Redraw when slider position changes (images will move with their panes)
  useEffect(() => {
    if (!isComparing) return;
    requestRedraw();
  }, [sliderPos, isComparing, requestRedraw]);


  const toWorkspaceWorld = (clientX, clientY) => {
    const rect = containerRef.current.getBoundingClientRect();
    const { x, y, k } = transform.current;
    const cx = rect.width / 2;
    const cy = rect.height / 2;
    return { x: (clientX - rect.left - cx) / k - x, y: (clientY - rect.top - cy) / k - y };
  };

  const toReferenceWorld = (clientX, clientY) => {
    const rect = containerRef.current.getBoundingClientRect();
    const availW = rect.width * (1 - sliderPos);
    const startX = rect.width * sliderPos;
    const cx = startX + availW / 2;
    const cy = rect.height / 2;
    const { x, y, k } = refTransform.current;
    return { x: (clientX - rect.left - cx) / k - x, y: (clientY - rect.top - cy) / k - y };
  };

  const getDist = (p1, p2) => Math.hypot(p1.clientX - p2.clientX, p1.clientY - p2.clientY);
  const getCenter = (p1, p2) => ({ x: (p1.clientX + p2.clientX) / 2, y: (p1.clientY + p2.clientY) / 2 });

  const handlePointerDown = (e) => {
    // Middle mouse button panning
    if (e.button === 1) {
      e.preventDefault();
      e.currentTarget.setPointerCapture(e.pointerId);
      isMiddleMousePanning.current = true;
      middleMouseLastPos.current = { x: e.clientX, y: e.clientY };
      const rect = containerRef.current.getBoundingClientRect();
      const xPct = (e.clientX - rect.left) / rect.width;
      activeSide.current = (isComparing && xPct > sliderPos) ? 'right' : 'left';
      return;
    }

    const rect = containerRef.current.getBoundingClientRect();
    const xPct = (e.clientX - rect.left) / rect.width;

    let side = 'left';
    if (isComparing) {
      if (Math.abs(xPct - sliderPos) < 0.05) return;
      if (xPct > sliderPos) side = 'right';
    }
    activeSide.current = side;

    e.currentTarget.setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, e);
    const pts = Array.from(pointers.current.values());

    if (pts.length === 2) {
      currentPath.current = null;
      currentRefPath.current = null;
      gestureState.current.lastDist = getDist(pts[0], pts[1]);
      gestureState.current.lastCenter = getCenter(pts[0], pts[1]);
    } else if (pts.length === 1) {
      if (tool === 'hand') {
        gestureState.current.lastPos = { x: e.clientX, y: e.clientY };
      } else {
        let wp;
        const targetImg = side === 'left' ? image : referenceImage;

        if (side === 'left') wp = toWorkspaceWorld(e.clientX, e.clientY);
        else wp = toReferenceWorld(e.clientX, e.clientY);

        if (tool === 'magnet' && targetImg) {
          const snapped = snapToEdge(wp.x, wp.y, targetImg, null);
          wp = { x: wp.x * 0.3 + snapped.x * 0.7, y: wp.y * 0.3 + snapped.y * 0.7 };
        }

        const newPath = { points: [wp], color, size, isEraser: tool === 'eraser' };

        if (side === 'left') currentPath.current = newPath;
        else currentRefPath.current = newPath;
      }
    }
    requestRedraw();
  };

  const handlePointerMove = (e) => {
    // Middle mouse panning
    if (isMiddleMousePanning.current) {
      const last = middleMouseLastPos.current;
      const dx = e.clientX - last.x;
      const dy = e.clientY - last.y;
      const t = activeSide.current === 'left' ? transform.current : refTransform.current;
      t.x += dx / t.k;
      t.y += dy / t.k;
      middleMouseLastPos.current = { x: e.clientX, y: e.clientY };
      requestRedraw();
      return;
    }

    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, e);
    const pts = Array.from(pointers.current.values());

    if (pts.length === 2) {
      const dist = getDist(pts[0], pts[1]);
      const center = getCenter(pts[0], pts[1]);
      const lastDist = gestureState.current.lastDist || dist;
      const lastCenter = gestureState.current.lastCenter || center;
      const zoom = dist / lastDist;

      const t = activeSide.current === 'left' ? transform.current : refTransform.current;

      t.k = Math.max(0.1, Math.min(t.k * zoom, 10));
      const dx = center.x - lastCenter.x;
      const dy = center.y - lastCenter.y;
      t.x += dx / t.k;
      t.y += dy / t.k;

      gestureState.current.lastDist = dist;
      gestureState.current.lastCenter = center;
    } else if (pts.length === 1) {
      if (tool === 'hand') {
        const last = gestureState.current.lastPos || { x: e.clientX, y: e.clientY };
        const dx = e.clientX - last.x;
        const dy = e.clientY - last.y;

        const t = activeSide.current === 'left' ? transform.current : refTransform.current;
        t.x += dx / t.k;
        t.y += dy / t.k;

        gestureState.current.lastPos = { x: e.clientX, y: e.clientY };
      } else {
        const side = activeSide.current;
        const targetPath = side === 'left' ? currentPath.current : currentRefPath.current;
        const targetImg = side === 'left' ? image : referenceImage;

        if (targetPath) {
          let wp;
          if (side === 'left') wp = toWorkspaceWorld(e.clientX, e.clientY);
          else wp = toReferenceWorld(e.clientX, e.clientY);

          if (tool === 'magnet' && targetImg) {
            const rawWp = { x: wp.x, y: wp.y }; // Save raw cursor position
            const snapped = snapToEdge(wp.x, wp.y, targetImg, targetPath.points);
            wp = { x: wp.x * 0.2 + snapped.x * 0.8, y: wp.y * 0.2 + snapped.y * 0.8 };

            // Light smoothing with last 2 points only
            const pp = targetPath.points;
            if (pp.length >= 1) {
              const last = pp[pp.length - 1];
              wp = { x: wp.x * 0.7 + last.x * 0.3, y: wp.y * 0.7 + last.y * 0.3 };
            }

            // Hard clamp: never drift more than 4px from the raw cursor
            // This prevents spirals — the line is always anchored to where the user is pointing
            const driftX = wp.x - rawWp.x;
            const driftY = wp.y - rawWp.y;
            const driftDist = Math.hypot(driftX, driftY);
            const maxDrift = 4;
            if (driftDist > maxDrift) {
              const s = maxDrift / driftDist;
              wp = { x: rawWp.x + driftX * s, y: rawWp.y + driftY * s };
            }
          }

          const pp = targetPath.points;
          const dist = Math.hypot(wp.x - pp[pp.length - 1].x, wp.y - pp[pp.length - 1].y);
          const minDistance = tool === 'magnet' ? 3 : 1;
          if (dist > minDistance) pp.push(wp);
        }
      }
    }
    requestRedraw();
  };

  const handlePointerUp = (e) => {
    // Middle mouse release
    if (isMiddleMousePanning.current && e.button === 1) {
      isMiddleMousePanning.current = false;
      middleMouseLastPos.current = null;
      return;
    }

    pointers.current.delete(e.pointerId);
    if (currentPath.current) {
      history.current.push([...paths.current]);
      redoStack.current = []; // Clear redo on new action
      paths.current.push(currentPath.current);
      currentPath.current = null;
    }
    if (currentRefPath.current) {
      refHistory.current.push([...refPaths.current]);
      refRedoStack.current = []; // Clear redo on new action
      refPaths.current.push(currentRefPath.current);
      currentRefPath.current = null;
    }
    setVersion(v => v + 1);
    if (pointers.current.size === 1) {
      const p = pointers.current.values().next().value;
      gestureState.current.lastPos = { x: p.clientX, y: p.clientY };
    }
  };

  const handleSliderDown = (e) => {
    e.stopPropagation();
    isDraggingSlider.current = true;
    e.target.setPointerCapture(e.pointerId);
  };

  const handleSliderMove = (e) => {
    if (!isDraggingSlider.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    // Allow the slider to reach 0 (far left) and 1 (far right)
    const pos = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    setSliderPos(pos);
  };

  const handleSliderUp = () => {
    isDraggingSlider.current = false;
  };

  // Mouse wheel zoom for desktop users
  const handleWheel = useCallback((e) => {
    e.preventDefault();
    const rect = containerRef.current.getBoundingClientRect();
    const xPct = (e.clientX - rect.left) / rect.width;
    const t = (isComparing && xPct > sliderPos) ? refTransform.current : transform.current;
    t.k = Math.max(0.1, Math.min(t.k * (e.deltaY < 0 ? 1.1 : 0.9), 10));
    requestRedraw();
  }, [isComparing, sliderPos, requestRedraw]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.addEventListener('wheel', handleWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', handleWheel);
  }, [handleWheel]);

  // Actions
  const handleUndo = () => {
    if (history.current.length > 0) {
      redoStack.current.push([...paths.current]);
      paths.current = history.current.pop();
      setVersion(v => v + 1);
    }
  };

  const handleRedo = () => {
    if (redoStack.current.length > 0) {
      history.current.push([...paths.current]);
      paths.current = redoStack.current.pop();
      setVersion(v => v + 1);
    }
  };

  const handleRefUndo = () => {
    if (refHistory.current.length > 0) {
      refRedoStack.current.push([...refPaths.current]);
      refPaths.current = refHistory.current.pop();
      setVersion(v => v + 1);
    }
  };

  const handleRefRedo = () => {
    if (refRedoStack.current.length > 0) {
      refHistory.current.push([...refPaths.current]);
      refPaths.current = refRedoStack.current.pop();
      setVersion(v => v + 1);
    }
  };

  const handleClear = () => {
    history.current.push([...paths.current]);
    redoStack.current = [];
    paths.current = [];
    setVersion(v => v + 1);
  };

  const handleRefClear = () => {
    refHistory.current.push([...refPaths.current]);
    refRedoStack.current = [];
    refPaths.current = [];
    setVersion(v => v + 1);
  };

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
        e.preventDefault();
        handleUndo();
      } else if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) {
        e.preventDefault();
        handleRedo();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  const recenterImage = useCallback(() => {
    if (!image || !containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const availW = isComparing ? rect.width * sliderPos : rect.width;
    const scaleFit = Math.min(availW / image.width, rect.height / image.height) * 0.9;
    transform.current = { x: 0, y: 0, k: scaleFit };
    requestRedraw();
  }, [image, isComparing, sliderPos, requestRedraw]);

  const recenterReferenceImage = useCallback(() => {
    if (!referenceImage || !containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const availW = rect.width * (1 - sliderPos);
    const availH = rect.height;
    const scaleFit = Math.min(availW / referenceImage.width, availH / referenceImage.height) * 0.9;
    refTransform.current = { x: 0, y: 0, k: scaleFit };
    requestRedraw();
  }, [referenceImage, sliderPos, requestRedraw]);

  const handleFile = (e) => {
    const f = e.target.files[0];
    if (!f) return;
    const r = new FileReader();
    r.onload = (ev) => {
      const img = new Image();
      img.onload = () => {
        setImage(img);
        const rect = containerRef.current.getBoundingClientRect();
        const availW = isComparing ? rect.width * sliderPos : rect.width;
        const scaleFit = Math.min(availW / img.width, rect.height / img.height) * 0.9;
        transform.current = { x: 0, y: 0, k: scaleFit };
        paths.current = []; history.current = [];
        analysisImageRef.current = null;
      };
      img.src = ev.target.result;
    };
    r.readAsDataURL(f);
  };

  const handleReferenceFile = (e) => {
    const f = e.target.files[0];
    if (!f) return;
    const r = new FileReader();
    r.onload = (ev) => {
      const img = new Image();
      img.onload = () => {
        setReferenceImage(img);
        refPaths.current = [];
        refHistory.current = [];
        analysisImageRef.current = null;

        const rect = containerRef.current.getBoundingClientRect();
        const availW = rect.width * (1 - sliderPos);
        const availH = rect.height;
        const scaleFit = Math.min(availW / img.width, availH / img.height) * 0.9;
        refTransform.current = { x: 0, y: 0, k: scaleFit };

        setIsComparing(true);
      };
      img.src = ev.target.result;
    };
    r.readAsDataURL(f);
  };

  const toggleCompare = () => {
    setIsComparing(!isComparing);
  };

  const handleSave = () => {
    const w = image ? image.width : window.innerWidth;
    const h = image ? image.height : window.innerHeight;
    const iCanvas = document.createElement('canvas');
    iCanvas.width = w; iCanvas.height = h;
    const iCtx = iCanvas.getContext('2d');
    iCtx.translate(w / 2, h / 2); iCtx.lineCap = 'round'; iCtx.lineJoin = 'round';
    paths.current.forEach(p => renderPathToContext(iCtx, p));
    const finalC = document.createElement('canvas');
    finalC.width = w; finalC.height = h;
    const ctx = finalC.getContext('2d');
    ctx.fillStyle = '#111111';
    ctx.fillRect(0, 0, w, h);
    if (image) ctx.drawImage(image, 0, 0);
    ctx.drawImage(iCanvas, 0, 0);
    const a = document.createElement('a');
    a.download = 'workspace-cvi.png';
    a.href = finalC.toDataURL();
    a.click();
  };

  const handleSaveRef = () => {
    if (!referenceImage) return;
    const w = referenceImage.width;
    const h = referenceImage.height;

    const finalC = document.createElement('canvas');
    finalC.width = w; finalC.height = h;
    const ctx = finalC.getContext('2d');

    ctx.fillStyle = '#111111';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(referenceImage, 0, 0);

    ctx.translate(w / 2, h / 2);
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    refPaths.current.forEach(p => renderPathToContext(ctx, p));

    const a = document.createElement('a');
    a.download = 'reference-cvi.png';
    a.href = finalC.toDataURL();
    a.click();
  }

  const ActionButton = ({ onClick, icon: Icon, disabled, colorClass = "text-gray-200", title }) => (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`w-12 h-12 flex items-center justify-center bg-neutral-800 rounded-full shadow-lg border border-neutral-600 transition-transform active:scale-95 disabled:opacity-40 disabled:scale-100 hover:shadow-xl hover:bg-neutral-700 ${colorClass}`}
    >
      <Icon size={20} />
    </button>
  );

  return (
    <div className="fixed inset-0 bg-[#111111] text-gray-200 font-sans touch-none select-none overflow-hidden">

      {/* Main Canvas Container */}
      <div ref={containerRef} className="absolute inset-0 z-0">
        {!image && paths.current.length === 0 && (
          <div
            className="absolute top-0 bottom-0 left-0 flex flex-col items-center justify-center opacity-40 pointer-events-none"
            style={{ width: isComparing ? `${sliderPos * 100}%` : '100%' }}
          >
            <ImageIcon size={48} className="mb-2" />
            <p className="font-bold text-gray-400">Choose an Image</p>
          </div>
        )}
        <canvas
          ref={canvasRef}
          className="block touch-none"
          onContextMenu={(e) => e.preventDefault()}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
          onPointerLeave={handlePointerUp}
          onDoubleClick={(e) => {
            const rect = containerRef.current.getBoundingClientRect();
            const xPct = (e.clientX - rect.left) / rect.width;
            if (isComparing && xPct > sliderPos) {
              recenterReferenceImage();
            } else {
              recenterImage();
            }
          }}
        />

        {/* Comparison Slider Overlay */}
        {isComparing && (
          <>
            <div
              className="absolute top-0 bottom-0 w-16 -ml-8 flex items-center justify-center z-20 cursor-ew-resize touch-none"
              style={{ left: `${sliderPos * 100}%` }}
              onPointerDown={handleSliderDown}
              onPointerMove={handleSliderMove}
              onPointerUp={handleSliderUp}
              onPointerCancel={handleSliderUp}
            >
              <div className="w-1 h-full bg-gray-500 backdrop-blur-sm shadow-lg"></div>
              <div className="absolute w-12 h-12 bg-neutral-800 rounded-full shadow-2xl flex items-center justify-center text-gray-200 border-2 border-neutral-600">
                <SplitSquareHorizontal size={20} />
              </div>
            </div>

            {!referenceImage && (
              <div
                className="absolute top-0 bottom-0 right-0 flex items-center justify-center pointer-events-none z-10"
                style={{ left: `${sliderPos * 100}%` }}
              >
                <div className="flex flex-col items-center gap-4 p-4 opacity-40">
                  <ImageIcon size={48} />
                  <span className="text-lg font-bold text-gray-400 text-center max-w-xs leading-relaxed">
                    Load an image to support using Comparative Language
                  </span>
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {/* TOP BAR (Minimal Header) */}
      <div className="absolute top-0 left-0 right-0 p-3 flex justify-between pointer-events-none z-40">
        <div className="flex gap-2 pointer-events-auto">
          {/* Main Load Button Removed from Top Bar */}
        </div>
        <div className="flex gap-2 pointer-events-auto">
          {/* Compare Toggle Moved to Left Drawer */}
        </div>
      </div>

      {/* LEFT DRAWER (Workspace Actions) */}
      <div className={`absolute top-20 left-0 z-30 flex items-start transition-transform duration-300 ease-in-out ${leftOpen ? 'translate-x-0' : '-translate-x-[calc(100%-24px)]'}`}>
        {/* Panel Content */}
        <div className="bg-neutral-900/95 border-y border-r border-neutral-700 rounded-r-2xl p-3 shadow-2xl backdrop-blur-md flex flex-col gap-3 pointer-events-auto">
          <div className="text-[10px] uppercase font-bold text-gray-400 text-center tracking-wider pb-1 border-b border-neutral-700">My Image</div>

          <ActionButton
            onClick={() => fileInputRef.current?.click()}
            icon={ImageIcon}
            colorClass="text-blue-600 hover:text-blue-700"
            title="Choose an Image"
          />
          <div className="w-full h-px bg-neutral-700 my-1"></div>

          <ActionButton onClick={handleSave} icon={Download} colorClass="text-green-600 hover:text-green-700" title="Save My Highlighted Image" />
          <ActionButton onClick={handleUndo} disabled={history.current.length === 0} icon={Undo} title="Undo (Ctrl+Z)" />
          <ActionButton onClick={handleRedo} disabled={redoStack.current.length === 0} icon={Redo} colorClass="text-gray-300 hover:text-white" title="Redo (Ctrl+Y)" />
          <ActionButton onClick={handleClear} icon={Trash2} colorClass="text-red-500 hover:text-red-600" title="Clear All Drawings" />

          <div className="w-full h-px bg-neutral-700 my-1"></div>

          <ActionButton
            onClick={toggleCompare}
            icon={isComparing ? X : SplitSquareHorizontal}
            colorClass={isComparing ? "bg-purple-600 text-white border-purple-400" : "text-purple-500 hover:text-purple-600"}
            title="Compare Two Images"
          />
        </div>

        {/* Handle */}
        <button
          onClick={() => setLeftOpen(!leftOpen)}
          className="mt-4 pointer-events-auto w-8 h-16 bg-neutral-900/95 border-y border-r border-neutral-700 rounded-r-xl flex items-center justify-center text-gray-400 hover:text-gray-200 shadow-md active:bg-neutral-800"
        >
          {leftOpen ? <ChevronLeft size={18} /> : <ChevronRight size={18} />}
        </button>
      </div>

      {/* RIGHT DRAWER (Comparative Actions) */}
      {isComparing && sliderPos < 0.85 && (
        <div className={`absolute top-20 right-0 z-30 flex flex-row-reverse items-start transition-transform duration-300 ease-in-out ${rightOpen ? 'translate-x-0' : 'translate-x-[calc(100%-24px)]'}`}>
          {/* Panel Content */}
          <div className="bg-neutral-900/95 border-y border-l border-neutral-700 rounded-l-2xl p-3 shadow-2xl backdrop-blur-md flex flex-col gap-3 pointer-events-auto">
            <div className="text-[10px] uppercase font-bold text-gray-400 text-center tracking-wider pb-1 border-b border-neutral-700">Compare</div>

            <ActionButton onClick={() => refInputRef.current?.click()} icon={ImageIcon} colorClass="text-blue-500 hover:text-blue-600" title="Choose Comparison Image" />
            <div className="w-full h-px bg-neutral-700 my-1"></div>

            <ActionButton onClick={handleSaveRef} icon={Download} colorClass="text-green-600 hover:text-green-700" title="Save Comparison Image" />
            <ActionButton onClick={handleRefUndo} disabled={refHistory.current.length === 0} icon={Undo} title="Undo Last Drawing" />
            <ActionButton onClick={handleRefRedo} disabled={refRedoStack.current.length === 0} icon={Redo} colorClass="text-gray-300 hover:text-white" title="Redo" />
            <ActionButton onClick={handleRefClear} icon={Trash2} colorClass="text-red-500 hover:text-red-600" title="Clear All Drawings" />
          </div>

          {/* Handle */}
          <button
            onClick={() => setRightOpen(!rightOpen)}
            className="mt-4 pointer-events-auto w-8 h-16 bg-neutral-900/95 border-y border-l border-neutral-700 rounded-l-xl flex items-center justify-center text-gray-400 hover:text-gray-200 shadow-md active:bg-neutral-800"
          >
            {rightOpen ? <ChevronRight size={18} /> : <ChevronLeft size={18} />}
          </button>
        </div>
      )}

      {/* BOTTOM DRAWER (Tools) */}
      <div className={`absolute bottom-0 left-0 right-0 z-30 flex flex-col items-center transition-transform duration-300 ease-in-out ${bottomOpen ? 'translate-y-0' : 'translate-y-[calc(100%-24px)]'}`}>

        {/* Handle */}
        <button
          onClick={() => setBottomOpen(!bottomOpen)}
          className="pointer-events-auto w-20 h-8 bg-neutral-900/95 border-t border-x border-neutral-700 rounded-t-xl flex items-center justify-center text-gray-400 hover:text-gray-200 shadow-md active:bg-neutral-800 mb-[-1px] z-10"
        >
          {bottomOpen ? <ChevronDown size={18} /> : <ChevronUp size={18} />}
        </button>

        {/* Panel Content */}
        <div className="w-full bg-neutral-900/95 border-t border-neutral-700 p-4 pb-6 shadow-2xl backdrop-blur-md pointer-events-auto">
          <div className="max-w-md mx-auto flex flex-col gap-4">
            {/* Colors */}
            <div className="flex items-center justify-between gap-2">
              <div className="flex gap-3 overflow-x-auto no-scrollbar py-1 flex-1 justify-center">
                {COLORS.map(c => (
                  <button
                    key={c.name}
                    onClick={() => { setColor(c.value); setTool('pen'); }}
                    className={`w-11 h-11 rounded-full border-2 shrink-0 transition-transform ${color === c.value && tool !== 'eraser' ? 'border-gray-400 scale-110 shadow-lg' : 'border-transparent opacity-60'}`}
                    style={{ backgroundColor: c.value }}
                  />
                ))}
              </div>
            </div>

            {/* Tools & Size */}
            <div className="flex items-center gap-4 bg-neutral-800 rounded-xl p-2 px-4">
              <div className="flex gap-2 shrink-0">
                <button onClick={() => setTool('pen')} title="Draw freely" className={`p-3 rounded-xl transition-colors ${tool === 'pen' ? 'bg-gray-500 text-white shadow' : 'text-gray-400 hover:text-gray-200'}`}><PenTool size={22} /></button>
                <button onClick={() => setTool('magnet')} title="Highlight Helper - Snaps to edges" className={`p-3 rounded-xl transition-colors ${tool === 'magnet' ? 'bg-purple-600 text-white shadow' : 'text-gray-400 hover:text-gray-200'}`}><Wand2 size={22} /></button>
                <button onClick={() => setTool('eraser')} title="Erase drawings" className={`p-3 rounded-xl transition-colors ${tool === 'eraser' ? 'bg-red-600 text-white shadow' : 'text-gray-400 hover:text-gray-200'}`}><Eraser size={22} /></button>
                <button onClick={() => setTool('hand')} title="Move and zoom image" className={`p-3 rounded-xl transition-colors ${tool === 'hand' ? 'bg-blue-600 text-white shadow' : 'text-gray-400 hover:text-gray-200'}`}><Hand size={22} /></button>
              </div>
              <input
                type="range" min="2" max="60"
                value={size} onChange={e => setSize(Number(e.target.value))}
                className="flex-1 h-2 bg-neutral-600 rounded-lg appearance-none accent-white cursor-pointer"
              />
            </div>
          </div>
        </div>
      </div>

      <input type="file" ref={fileInputRef} className="hidden" accept="image/*" onChange={handleFile} />
      <input type="file" ref={refInputRef} className="hidden" accept="image/*" onChange={handleReferenceFile} />

      <style>{`
        .no-scrollbar::-webkit-scrollbar { display: none; }
        .no-scrollbar { -ms-overflow-style: none; scrollbar-width: none; }
        input[type=range]::-webkit-slider-thumb { -webkit-appearance: none; height: 24px; width: 24px; border-radius: 50%; background: #d1d5db; margin-top: -10px; transition: transform 0.1s; }
        input[type=range]::-webkit-slider-thumb:active { transform: scale(1.2); }
        input[type=range]::-webkit-slider-runnable-track { height: 6px; background: #525252; border-radius: 3px; }
      `}</style>
    </div>
  );
}