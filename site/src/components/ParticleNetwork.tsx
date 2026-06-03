import { useEffect, useRef } from "react";

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  baseVx: number;
  baseVy: number;
  radius: number;
  opacity: number;
}

interface ParticleNetworkProps {
  mode?: "light" | "dark";
}

export default function ParticleNetwork({ mode = "light" }: ParticleNetworkProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const mouseRef = useRef({ x: -1000, y: -1000 });
  const particlesRef = useRef<Particle[]>([]);
  const animRef = useRef<number>(0);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const CONNECTION_DIST = 120;
    const MOUSE_RADIUS = 180;
    const MOUSE_FORCE = 0.015;
    const PARTICLE_COUNT = 80;
    const lineColor = mode === "dark" ? "56, 189, 248" : "0, 0, 0";
    const dotColor = mode === "dark" ? "251, 191, 36" : "0, 0, 0";

    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      const rect = canvas.getBoundingClientRect();
      canvas.width = rect.width * dpr;
      canvas.height = rect.height * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      initParticles(rect.width, rect.height);
    };

    const initParticles = (w: number, h: number) => {
      const count = Math.min(PARTICLE_COUNT, Math.floor((w * h) / 12000));
      particlesRef.current = Array.from({ length: count }, () => {
        const vx = (Math.random() - 0.5) * 0.4;
        const vy = (Math.random() - 0.5) * 0.4;
        return {
          x: Math.random() * w,
          y: Math.random() * h,
          vx,
          vy,
          baseVx: vx,
          baseVy: vy,
          radius: Math.random() * 1.5 + 0.8,
          opacity: Math.random() * 0.4 + 0.2,
        };
      });
    };

    resize();
    window.addEventListener("resize", resize);

    const handleMouseMove = (e: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      mouseRef.current.x = e.clientX - rect.left;
      mouseRef.current.y = e.clientY - rect.top;
    };

    const handleMouseLeave = () => {
      mouseRef.current.x = -1000;
      mouseRef.current.y = -1000;
    };

    canvas.addEventListener("mousemove", handleMouseMove);
    canvas.addEventListener("mouseleave", handleMouseLeave);

    const animate = () => {
      const rect = canvas.getBoundingClientRect();
      const w = rect.width;
      const h = rect.height;
      const mouse = mouseRef.current;

      ctx.clearRect(0, 0, w, h);

      const particles = particlesRef.current;

      for (const p of particles) {
        const dx = mouse.x - p.x;
        const dy = mouse.y - p.y;
        const dist = Math.sqrt(dx * dx + dy * dy);

        if (dist < MOUSE_RADIUS) {
          const force = (1 - dist / MOUSE_RADIUS) * MOUSE_FORCE;
          p.vx += dx * force;
          p.vy += dy * force;
        }

        p.vx += (p.baseVx - p.vx) * 0.02;
        p.vy += (p.baseVy - p.vy) * 0.02;

        p.x += p.vx;
        p.y += p.vy;

        if (p.x < 0) p.x = w;
        if (p.x > w) p.x = 0;
        if (p.y < 0) p.y = h;
        if (p.y > h) p.y = 0;
      }

      for (let i = 0; i < particles.length; i++) {
        for (let j = i + 1; j < particles.length; j++) {
          const dx = particles[i].x - particles[j].x;
          const dy = particles[i].y - particles[j].y;
          const dist = Math.sqrt(dx * dx + dy * dy);

          if (dist < CONNECTION_DIST) {
            const alpha = (1 - dist / CONNECTION_DIST) * 0.15;
            ctx.beginPath();
            ctx.moveTo(particles[i].x, particles[i].y);
            ctx.lineTo(particles[j].x, particles[j].y);
            ctx.strokeStyle = `rgba(${lineColor}, ${alpha})`;
            ctx.lineWidth = 0.6;
            ctx.stroke();
          }
        }
      }

      for (const p of particles) {
        const dx = mouse.x - p.x;
        const dy = mouse.y - p.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const highlight = dist < MOUSE_RADIUS ? (1 - dist / MOUSE_RADIUS) * 0.6 : 0;

        ctx.beginPath();
        ctx.arc(p.x, p.y, p.radius + highlight * 1.5, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(${dotColor}, ${p.opacity + highlight})`;
        ctx.fill();
      }

      animRef.current = requestAnimationFrame(animate);
    };

    animRef.current = requestAnimationFrame(animate);

    return () => {
      cancelAnimationFrame(animRef.current);
      window.removeEventListener("resize", resize);
      canvas.removeEventListener("mousemove", handleMouseMove);
      canvas.removeEventListener("mouseleave", handleMouseLeave);
    };
  }, [mode]);

  return (
    <canvas
      ref={canvasRef}
      className="absolute inset-0 w-full h-full"
      style={{ cursor: "default" }}
    />
  );
}
