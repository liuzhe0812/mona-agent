import { useState, useEffect } from "react";

interface TypewriterTextProps {
  texts: string[];
  speed?: number;
}

export default function TypewriterText({ texts, speed = 80 }: TypewriterTextProps) {
  const [displayed, setDisplayed] = useState("");
  const [textIndex, setTextIndex] = useState(0);
  const [isDeleting, setIsDeleting] = useState(false);

  useEffect(() => {
    const current = texts[textIndex];

    const timeout = setTimeout(
      () => {
        if (!isDeleting) {
          setDisplayed(current.slice(0, displayed.length + 1));
          if (displayed.length + 1 === current.length) {
            setTimeout(() => setIsDeleting(true), 2000);
          }
        } else {
          setDisplayed(current.slice(0, displayed.length - 1));
          if (displayed.length - 1 === 0) {
            setIsDeleting(false);
            setTextIndex((prev) => (prev + 1) % texts.length);
          }
        }
      },
      isDeleting ? speed / 2 : speed,
    );

    return () => clearTimeout(timeout);
  }, [displayed, isDeleting, textIndex, texts, speed]);

  return (
    <span>
      {displayed}
      <span className="animate-cursor-blink text-black">|</span>
    </span>
  );
}
