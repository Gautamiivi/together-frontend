import { useEffect, useRef, useState } from "react";

let scriptLoadingPromise;

function loadYouTubeScript() {
  if (window.YT && window.YT.Player) {
    return Promise.resolve();
  }

  if (!scriptLoadingPromise) {
    scriptLoadingPromise = new Promise((resolve) => {
      const existing = document.querySelector('script[src="https://www.youtube.com/iframe_api"]');
      if (!existing) {
        const script = document.createElement("script");
        script.src = "https://www.youtube.com/iframe_api";
        script.async = true;
        document.body.appendChild(script);
      }

      const previous = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = () => {
        if (typeof previous === "function") previous();
        resolve();
      };
    });
  }

  return scriptLoadingPromise;
}

export default function useYouTubePlayer() {
  const containerRef = useRef(null);
  const playerRef = useRef(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let isMounted = true;

    loadYouTubeScript().then(() => {
      if (!isMounted || !containerRef.current) return;
      playerRef.current = new window.YT.Player(containerRef.current, {
        videoId: "dQw4w9WgXcQ",
        playerVars: {
          playsinline: 1,
          rel: 0,
        },
        events: {
          onReady: () => setReady(true),
        },
      });
    });

    return () => {
      isMounted = false;
      if (playerRef.current && playerRef.current.destroy) {
        playerRef.current.destroy();
      }
    };
  }, []);

  return {
    containerRef,
    playerRef,
    ready,
  };
}
