import { useRef, useState } from "react";
import { motion } from "framer-motion";

interface TiltCardProps {
  children: React.ReactNode;
  className?: string;
}

export default function TiltCard({ children, className = "" }: TiltCardProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [rotate, setRotate] = useState({ x: 0, y: 0 });
  const [hovered, setHovered] = useState(false);

  const handleMouse = (e: React.MouseEvent<HTMLDivElement>) => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width - 0.5;
    const y = (e.clientY - rect.top) / rect.height - 0.5;
    setRotate({ x: -y * 6, y: x * 6 });
  };

  const handleEnter = () => setHovered(true);
  const handleLeave = () => {
    setRotate({ x: 0, y: 0 });
    setHovered(false);
  };

  return (
    <motion.div
      ref={ref}
      className={className}
      onMouseMove={handleMouse}
      onMouseEnter={handleEnter}
      onMouseLeave={handleLeave}
      animate={{
        rotateX: rotate.x,
        rotateY: rotate.y,
        boxShadow: hovered
          ? "0 20px 40px rgba(0, 0, 0, 0.08)"
          : "0 0 0 rgba(0, 0, 0, 0)",
      }}
      transition={{ type: "spring", stiffness: 200, damping: 20, mass: 0.5 }}
      style={{ perspective: "1000px", transformStyle: "preserve-3d" }}
    >
      {children}
    </motion.div>
  );
}
