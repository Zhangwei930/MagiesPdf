import { useEffect, useRef, useState } from 'react';
import type { Point, Size } from '../pdf/geometry.ts';
import type { InkAnnotation } from '../pdf/inkAnnotation.ts';

export function DrawingOverlay({
  size,
  scale,
  existingInks = [],
  onFinishStroke,
}: {
  size: Size;
  scale: number;
  existingInks?: InkAnnotation[];
  onFinishStroke?(ink: Omit<InkAnnotation, 'id' | 'pageNumber'>): void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [drawing, setDrawing] = useState(false);
  const [currentStroke, setCurrentStroke] = useState<Point[]>([]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    const drawStroke = (pts: Point[], color: string, width: number) => {
      const first = pts[0];
      if (pts.length < 2 || !first) return;
      ctx.beginPath();
      ctx.strokeStyle = color;
      ctx.lineWidth = width * scale;
      ctx.moveTo(first.x * scale, first.y * scale);
      for (let i = 1; i < pts.length; i++) {
        const pt = pts[i];
        if (pt) ctx.lineTo(pt.x * scale, pt.y * scale);
      }
      ctx.stroke();
    };

    existingInks.forEach((ink) => {
      drawStroke(ink.points, ink.color, ink.strokeWidth);
    });

    if (currentStroke.length > 0) {
      drawStroke(currentStroke, '#ff0000', 2);
    }
  }, [existingInks, currentStroke, scale]);

  const getPoint = (e: React.MouseEvent | React.TouchEvent): Point | null => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return null;
    let clientX, clientY;
    if ('touches' in e) {
      clientX = e.touches[0]?.clientX;
      clientY = e.touches[0]?.clientY;
    } else {
      clientX = e.clientX;
      clientY = e.clientY;
    }
    if (clientX === undefined || clientY === undefined) return null;
    return {
      x: (clientX - rect.left) / scale,
      y: (clientY - rect.top) / scale,
    };
  };

  const handleStart = (e: React.MouseEvent | React.TouchEvent) => {
    const pt = getPoint(e);
    if (!pt) return;
    setDrawing(true);
    setCurrentStroke([pt]);
  };

  const handleMove = (e: React.MouseEvent | React.TouchEvent) => {
    if (!drawing) return;
    const pt = getPoint(e);
    if (!pt) return;
    setCurrentStroke((prev) => [...prev, pt]);
  };

  const handleEnd = () => {
    if (drawing && currentStroke.length > 1 && onFinishStroke) {
      onFinishStroke({
        points: currentStroke,
        color: '#ff0000',
        strokeWidth: 2,
      });
    }
    setDrawing(false);
    setCurrentStroke([]);
  };

  return (
    <canvas
      ref={canvasRef}
      width={size.width * scale}
      height={size.height * scale}
      className="absolute top-0 left-0 z-20 cursor-crosshair touch-none"
      onMouseDown={handleStart}
      onMouseMove={handleMove}
      onMouseUp={handleEnd}
      onMouseLeave={handleEnd}
      onTouchStart={handleStart}
      onTouchMove={handleMove}
      onTouchEnd={handleEnd}
    />
  );
}
