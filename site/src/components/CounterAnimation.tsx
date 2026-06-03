import { useState, useEffect, useRef } from "react";
import { motion, useInView } from "framer-motion";

interface CounterAnimationProps {
  target: number;
  suffix?: string;
  duration?: number;
}

export default function CounterAnimation({
  target,
  suffix = "",
  duration = 2,
}: CounterAnimationProps) {
  const ref = useRef(null);
  const isInView = useInView(ref, { once: true });

  return (
    <motion.span
      ref={ref}
      initial={{ opacity: 0 }}
      animate={isInView ? { opacity: 1 } : {}}
    >
      {isInView ? (
        <CountUp target={target} suffix={suffix} duration={duration} />
      ) : (
        `0${suffix}`
      )}
    </motion.span>
  );
}

function CountUp({
  target,
  suffix,
  duration,
}: {
  target: number;
  suffix: string;
  duration: number;
}) {
  const [count, setCount] = useState(0);

  useEffect(() => {
    let start = 0;
    const step = target / (duration * 60);
    const timer = setInterval(() => {
      start += step;
      if (start >= target) {
        setCount(target);
        clearInterval(timer);
      } else {
        setCount(Math.floor(start));
      }
    }, 1000 / 60);
    return () => clearInterval(timer);
  }, [target, duration]);

  return (
    <>
      {count}
      {suffix}
    </>
  );
}
