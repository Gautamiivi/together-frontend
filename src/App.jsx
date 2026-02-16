import { useEffect, useMemo, useRef, useState } from "react";
import { io } from "socket.io-client";
import useYouTubePlayer from "./hooks/useYouTubePlayer";

const DEFAULT_VIDEO = {
  videoId: "dQw4w9WgXcQ",
  title: "Starter Video",
  channelTitle: "Together",
  thumbnail: "",
};

function toVideoObject(item) {
  return {
    videoId: item?.videoId || "",
    channelId: item?.channelId || "",
    title: item?.title || "Untitled",
    channelTitle: item?.channelTitle || "Unknown channel",
    thumbnail: item?.thumbnail || "",
  };
}

function VideoCard({ video, onSelect, compact }) {
  return (
    <button className={`video-card ${compact ? "compact" : ""}`} onClick={() => onSelect(video)}>
      <img src={video.thumbnail} alt={video.title} />
      <div className="video-meta">
        <strong>{video.title}</strong>
        <small>{video.channelTitle}</small>
      </div>
    </button>
  );
}

export default function App() {
  const backendBase = (import.meta.env.VITE_BACKEND_URL || "http://localhost:4000").trim().replace(/\/$/, "");
  const { containerRef, playerRef, ready } = useYouTubePlayer();

  const [username, setUsername] = useState("");
  const [roomCodeInput, setRoomCodeInput] = useState("");
  const [roomCode, setRoomCode] = useState("");
  const [status, setStatus] = useState("Search and select a video");
  const [messages, setMessages] = useState([]);
  const [chatInput, setChatInput] = useState("");
  const [joined, setJoined] = useState(false);

  const [query, setQuery] = useState("trending songs");
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchResults, setSearchResults] = useState([]);
  const [resultsMode, setResultsMode] = useState("search");

  const [relatedLoading, setRelatedLoading] = useState(false);
  const [relatedResults, setRelatedResults] = useState([]);
  const [activePage, setActivePage] = useState(0);
  const [unreadChats, setUnreadChats] = useState(0);
  const [isMobileViewport, setIsMobileViewport] = useState(false);

  const [currentVideo, setCurrentVideo] = useState(DEFAULT_VIDEO);

  const socketRef = useRef(null);
  const suppressRef = useRef(false);
  const lastStateRef = useRef(-1);
  const layoutRef = useRef(null);
  const activePageRef = useRef(0);

  const displayRoomCode = useMemo(() => roomCode || "-", [roomCode]);

  function findKnownVideo(videoId) {
    return (
      searchResults.find((v) => v.videoId === videoId) ||
      relatedResults.find((v) => v.videoId === videoId) ||
      { ...DEFAULT_VIDEO, videoId }
    );
  }

  function triggerHaptic(pattern = [12]) {
    if (typeof window !== "undefined" && typeof window.navigator?.vibrate === "function") {
      window.navigator.vibrate(pattern);
    }
  }

  useEffect(() => {
    searchVideos("trending songs");
  }, []);

  useEffect(() => {
    const checkMobile = () => setIsMobileViewport(window.innerWidth <= 900);
    checkMobile();
    window.addEventListener("resize", checkMobile);
    return () => window.removeEventListener("resize", checkMobile);
  }, []);

  useEffect(() => {
    const el = layoutRef.current;
    if (!el || !isMobileViewport) return;

    const onScroll = () => {
      const page = Math.max(0, Math.min(2, Math.round(el.scrollLeft / Math.max(el.clientWidth, 1))));
      if (page === activePageRef.current) return;

      activePageRef.current = page;
      setActivePage(page);
      triggerHaptic([10]);
    };

    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [isMobileViewport]);

  useEffect(() => {
    activePageRef.current = activePage;
    if (activePage === 2) {
      setUnreadChats(0);
    }
  }, [activePage]);

  useEffect(() => {
    return () => {
      if (socketRef.current) socketRef.current.disconnect();
    };
  }, []);

  useEffect(() => {
    if (!ready || !currentVideo.videoId) return;
    playerRef.current?.loadVideoById(currentVideo.videoId, 0);
  }, [ready, currentVideo.videoId, playerRef]);

  useEffect(() => {
    if (!ready || !joined || !socketRef.current || !playerRef.current || !window.YT) return;

    const onTick = setInterval(() => {
      const player = playerRef.current;
      const socket = socketRef.current;
      if (!player || !socket || suppressRef.current) return;

      const state = player.getPlayerState();
      if (state !== window.YT.PlayerState.PLAYING && state !== window.YT.PlayerState.PAUSED) return;
      socket.emit("sync-seek", { currentTime: player.getCurrentTime() });
    }, 5000);

    return () => clearInterval(onTick);
  }, [ready, joined, playerRef]);

  function connectSocket() {
    if (!socketRef.current) {
      socketRef.current = io(backendBase, {
        transports: ["websocket", "polling"],
      });

      socketRef.current.on("connect", () => {
        setStatus("Connected");
      });

      socketRef.current.on("join-error", ({ message }) => {
        setStatus(message || "Join failed");
      });

      socketRef.current.on("room-state", ({ roomCode: incomingCode, videoId, isPlaying, currentTime, chat }) => {
        if (incomingCode) setRoomCode(incomingCode);
        const player = playerRef.current;
        if (!player) return;

        if (videoId) {
          const newVideo = findKnownVideo(videoId);
          setCurrentVideo(newVideo);
          setResultsMode("related");
          fetchRelated(videoId, newVideo.channelId || "");
          player.loadVideoById(videoId, 0);
        }

        suppressRef.current = true;
        setTimeout(() => {
          player.seekTo(currentTime || 0, true);
          if (isPlaying) player.playVideo();
          else player.pauseVideo();
        }, 200);
        setTimeout(() => {
          suppressRef.current = false;
        }, 700);

        setMessages((chat || []).map((m) => ({ ...m, kind: "chat" })));
        setStatus("Joined room");
        setJoined(true);
      });

      socketRef.current.on("video-changed", ({ videoId, by }) => {
        const player = playerRef.current;
        if (videoId) {
          const newVideo = findKnownVideo(videoId);
          setCurrentVideo(newVideo);
          setResultsMode("related");
          fetchRelated(videoId, newVideo.channelId || "");
        }

        if (player && videoId) {
          suppressRef.current = true;
          player.loadVideoById(videoId, 0);
          setTimeout(() => {
            suppressRef.current = false;
          }, 500);
        }

        setMessages((prev) => [
          ...prev,
          { id: `sys-${Date.now()}`, kind: "system", text: `Video changed by ${by}` },
        ]);
      });

      socketRef.current.on("sync-play", ({ currentTime }) => {
        const player = playerRef.current;
        if (!player) return;
        suppressRef.current = true;
        player.seekTo(currentTime || 0, true);
        player.playVideo();
        setTimeout(() => {
          suppressRef.current = false;
        }, 400);
      });

      socketRef.current.on("sync-pause", ({ currentTime }) => {
        const player = playerRef.current;
        if (!player) return;
        suppressRef.current = true;
        player.seekTo(currentTime || 0, true);
        player.pauseVideo();
        setTimeout(() => {
          suppressRef.current = false;
        }, 400);
      });

      socketRef.current.on("sync-seek", ({ currentTime }) => {
        const player = playerRef.current;
        if (!player) return;
        suppressRef.current = true;
        player.seekTo(currentTime || 0, true);
        setTimeout(() => {
          suppressRef.current = false;
        }, 200);
      });

      socketRef.current.on("chat-message", (message) => {
        setMessages((prev) => [...prev, { ...message, kind: "chat" }]);
        if (activePageRef.current !== 2 && message?.username !== username.trim()) {
          setUnreadChats((count) => count + 1);
          triggerHaptic([18, 25, 18]);
        }
      });

      socketRef.current.on("system-message", ({ text }) => {
        setMessages((prev) => [...prev, { id: `sys-${Date.now()}`, kind: "system", text }]);
      });
    }

    return socketRef.current;
  }

  async function createRoom() {
    const cleanName = username.trim();
    const videoId = currentVideo.videoId;

    if (!cleanName) {
      setStatus("Enter username");
      return;
    }
    if (!videoId) {
      setStatus("Select a video first");
      return;
    }

    setStatus("Creating room...");

    try {
      const res = await fetch(`${backendBase}/api/rooms/create`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ videoId }),
      });

      if (!res.ok) throw new Error("Room creation failed");
      const data = await res.json();
      const socket = connectSocket();
      setRoomCode(data.roomCode);
      setRoomCodeInput(data.roomCode);
      socket.emit("join-room", { roomCode: data.roomCode, username: cleanName });
    } catch (error) {
      setStatus(error.message || "Failed to create room");
    }
  }

  async function joinRoom() {
    const cleanName = username.trim();
    const code = roomCodeInput.trim().toUpperCase();

    if (!cleanName) {
      setStatus("Enter username");
      return;
    }
    if (!/^[A-Z0-9]{6}$/.test(code)) {
      setStatus("Room code must be 6 letters/numbers");
      return;
    }

    setStatus("Joining room...");

    try {
      const check = await fetch(`${backendBase}/api/rooms/${code}`);
      if (!check.ok) throw new Error("Room not found");

      const socket = connectSocket();
      setRoomCode(code);
      socket.emit("join-room", { roomCode: code, username: cleanName });
    } catch (error) {
      setStatus(error.message || "Failed to join room");
    }
  }

  async function searchVideos(term = query) {
    const q = String(term || "").trim();
    if (!q) return;

    setSearchLoading(true);
    setStatus("Searching YouTube...");

    try {
      const res = await fetch(`${backendBase}/api/youtube/search?q=${encodeURIComponent(q)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data?.message || "YouTube search failed");

      const items = (data.results || []).map(toVideoObject);
      setSearchResults(items);
      setResultsMode("search");

      if (!currentVideo.videoId && items[0]) {
        selectVideo(items[0], false);
      }

      setStatus(`Found ${items.length} videos`);
    } catch (error) {
      setStatus(String(error?.message || "Search failed"));
    } finally {
      setSearchLoading(false);
    }
  }

  async function fetchRelated(videoId, channelId = "") {
    if (!videoId) return;
    setRelatedLoading(true);

    try {
      const qs = new URLSearchParams({ videoId });
      if (channelId) qs.set("channelId", channelId);
      const res = await fetch(`${backendBase}/api/youtube/related?${qs.toString()}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data?.message || "Failed to fetch related videos");
      const recs = (data.results || []).map(toVideoObject);
      setRelatedResults(recs);
    } catch {
      setRelatedResults([]);
    } finally {
      setRelatedLoading(false);
    }
  }

  function selectVideo(video, broadcast = true) {
    if (!video?.videoId) return;

    setCurrentVideo(video);
    setResultsMode("related");
    fetchRelated(video.videoId, video.channelId || "");

    if (ready && playerRef.current) {
      playerRef.current.loadVideoById(video.videoId, 0);
    }

    if (broadcast && joined && socketRef.current) {
      socketRef.current.emit("set-video", { videoId: video.videoId });
      setStatus("Video synced to room");
    }
  }

  function sendMessage(e) {
    e.preventDefault();
    if (!joined || !socketRef.current) return;

    const text = chatInput.trim();
    if (!text) return;
    socketRef.current.emit("chat-message", { text });
    setChatInput("");
  }

  function scrollToPage(page) {
    const el = layoutRef.current;
    if (!el || !isMobileViewport) return;
    el.scrollTo({
      left: page * el.clientWidth,
      behavior: "smooth",
    });
  }

  function handlePlayerStateChange() {
    if (!joined || !ready || !socketRef.current || !playerRef.current || !window.YT || suppressRef.current) return;

    const state = playerRef.current.getPlayerState();
    if (state === lastStateRef.current) return;
    lastStateRef.current = state;

    if (state === window.YT.PlayerState.PLAYING) {
      socketRef.current.emit("sync-play", { currentTime: playerRef.current.getCurrentTime() });
    } else if (state === window.YT.PlayerState.PAUSED) {
      socketRef.current.emit("sync-pause", { currentTime: playerRef.current.getCurrentTime() });
    }
  }

  useEffect(() => {
    if (!ready || !playerRef.current || !window.YT) return;

    const interval = setInterval(() => {
      handlePlayerStateChange();
    }, 250);

    return () => clearInterval(interval);
  }, [ready, joined]);

  return (
    <>
      <div className="mobile-page-indicator">
        <button className={activePage === 0 ? "active" : ""} onClick={() => scrollToPage(0)}>Info</button>
        <button className={activePage === 1 ? "active" : ""} onClick={() => scrollToPage(1)}>Videos</button>
        <button className={activePage === 2 ? "active" : ""} onClick={() => scrollToPage(2)}>
          Chats
          {unreadChats > 0 ? <span className="badge">{Math.min(unreadChats, 99)}</span> : null}
        </button>
      </div>

      <div className="layout" ref={layoutRef}>
      <aside className="panel room-panel">
        <div className="panel-title-row">
          <h1>Together ❤️</h1>
          <span className={`state-pill ${joined ? "live" : ""}`}>{joined ? "IN ROOM" : "READY"}</span>
        </div>
        <p className="muted-text">Search videos, create room, share code, watch together.</p>

        <label>Your name</label>
        <input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="Enter your name" />

        <div className="room-actions">
          <button onClick={createRoom}>Create Room</button>
        </div>

        <label>Join with room code</label>
        <input
          value={roomCodeInput}
          onChange={(e) => setRoomCodeInput(e.target.value.toUpperCase())}
          placeholder="ABC123"
          maxLength={6}
        />
        <button className="join" onClick={joinRoom}>Join Room</button>

        <div className="room-code-card">
          <div className="label-muted">Room Code</div>
          <div className="code">{displayRoomCode}</div>
          <button
            className="copy"
            onClick={async () => {
              if (!roomCode) return;
              await navigator.clipboard.writeText(roomCode);
              setStatus("Room code copied");
            }}
          >
            Copy Code
          </button>
        </div>

        <div className="status">Status: {status}</div>
      </aside>

      <section className="panel main-panel">
        <div className="yt-brand">
          <span className="yt-logo" aria-hidden="true" />
          <span>YouTube Search</span>
        </div>
        <form
          className="search-box"
          onSubmit={(e) => {
            e.preventDefault();
            searchVideos();
          }}
        >
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search on YouTube"
          />
          <button type="submit" disabled={searchLoading}>{searchLoading ? "..." : "Search"}</button>
        </form>

        <div className="player-wrap">
          <div ref={containerRef} id="yt-player" />
          <div className="now-playing">
            <h3>{currentVideo.title || "Select a video"}</h3>
            <p>{currentVideo.channelTitle || ""}</p>
          </div>
        </div>

        <div className="kpi-row">
          <article className="kpi-card">
            <span>Search Pool</span>
            <strong>{searchResults.length}</strong>
          </article>
          <article className="kpi-card">
            <span>Recommendations</span>
            <strong>{relatedResults.length}</strong>
          </article>
          <article className="kpi-card">
            <span>Live Messages</span>
            <strong>{messages.length}</strong>
          </article>
        </div>

        <div className="mid-section">
          <div>
            <div className="section-head">
              <h2>{resultsMode === "related" ? "More From This Channel" : "Search Results"}</h2>
              <span>{resultsMode === "related" ? relatedResults.length : searchResults.length}</span>
            </div>
            <div className="video-grid">
              {resultsMode === "search" && searchLoading ? <p className="muted-text">Searching videos...</p> : null}
              {resultsMode === "related" && relatedLoading ? <p className="muted-text">Loading channel videos...</p> : null}
              {resultsMode === "search" && !searchLoading && searchResults.length === 0 ? (
                <p className="muted-text">No videos found.</p>
              ) : null}
              {resultsMode === "related" && !relatedLoading && relatedResults.length === 0 ? (
                <p className="muted-text">Search and pick a video to load this channel's videos.</p>
              ) : null}
              {(resultsMode === "related" ? relatedResults : searchResults).map((video) => (
                <VideoCard key={`${resultsMode}-${video.videoId}`} video={video} onSelect={selectVideo} compact />
              ))}
            </div>
          </div>
        </div>
      </section>

      <section className="panel chat-panel">
        <h2>Live Chat</h2>
        <div className="chat-list">
          {messages.map((m, idx) => (
            <div
              key={m.id || `${m.text}-${idx}`}
              className={`chat-item ${m.kind === "system" ? "system" : ""} ${m.username === username.trim() ? "mine" : ""}`}
            >
              {m.kind === "chat" ? (
                <>
                  <strong>{m.username}</strong>
                  <p>{m.text}</p>
                </>
              ) : (
                <em>{m.text}</em>
              )}
            </div>
          ))}
        </div>

        <form onSubmit={sendMessage} className="chat-form">
          <input value={chatInput} onChange={(e) => setChatInput(e.target.value)} placeholder="Type message..." />
          <button type="submit">Send</button>
        </form>
      </section>
      </div>
    </>
  );
}
