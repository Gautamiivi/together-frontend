import { useEffect, useMemo, useRef, useState } from "react";
import { io } from "socket.io-client";
import useYouTubePlayer from "./hooks/useYouTubePlayer";

const DEFAULT_VIDEO = {
  videoId: "dQw4w9WgXcQ",
  title: "Starter Video",
  channelTitle: "Together",
  thumbnail: "",
};
const SYNC_BUFFER_SECONDS = 0.25;
const PLAY_DRIFT_THRESHOLD = 1.0;
const PAUSE_DRIFT_THRESHOLD = 0.35;
const SEEK_JUMP_THRESHOLD = 1.2;
const SEEK_EMIT_COOLDOWN_MS = 900;

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
  const [isHost, setIsHost] = useState(false);

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
  const lastSampleRef = useRef({ time: 0, at: 0, state: -1 });
  const lastSeekEmitRef = useRef(0);
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

    let rafId = 0;
    const getPagePitch = () => {
      const firstPanel = el.querySelector(".panel");
      if (!firstPanel) return el.clientWidth;
      const styles = window.getComputedStyle(el);
      const gapValue = parseFloat(styles.columnGap || styles.gap || "0") || 0;
      return firstPanel.getBoundingClientRect().width + gapValue;
    };

    const onScroll = () => {
      if (rafId) cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        const pitch = Math.max(getPagePitch(), 1);
        const page = Math.max(0, Math.min(2, Math.round(el.scrollLeft / pitch)));
        if (page === activePageRef.current) return;
        activePageRef.current = page;
        setActivePage(page);
        triggerHaptic([16]);
      });
    };

    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      if (rafId) cancelAnimationFrame(rafId);
      el.removeEventListener("scroll", onScroll);
    };
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

  function applyRemoteSync(payload, options = {}) {
    const player = playerRef.current;
    if (!player || !window.YT) return;

    const { forceSeek = false } = options;
    const isPlaying = Boolean(payload?.isPlaying);
    const baseTime = Number(payload?.currentTime) || 0;
    const serverNow = Number(payload?.serverNow) || 0;
    const transitSeconds = serverNow > 0 ? Math.max(0, (Date.now() - serverNow) / 1000) : 0;
    const targetTime = Math.max(0, baseTime + (isPlaying ? transitSeconds + SYNC_BUFFER_SECONDS : 0));

    const localTime = Number(player.getCurrentTime?.() || 0);
    const localState = player.getPlayerState?.();
    const drift = Math.abs(localTime - targetTime);
    const threshold = isPlaying ? PLAY_DRIFT_THRESHOLD : PAUSE_DRIFT_THRESHOLD;
    const shouldSeek = forceSeek ? drift > 0.2 : drift > threshold;

    suppressRef.current = true;
    if (shouldSeek) player.seekTo(targetTime, true);
    if (isPlaying && localState !== window.YT.PlayerState.PLAYING) player.playVideo();
    if (!isPlaying && localState === window.YT.PlayerState.PLAYING) player.pauseVideo();

    lastSampleRef.current = {
      time: targetTime,
      at: Date.now(),
      state: isPlaying ? window.YT.PlayerState.PLAYING : window.YT.PlayerState.PAUSED,
    };

    setTimeout(() => {
      suppressRef.current = false;
    }, 350);
  }

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

      socketRef.current.on("action-error", ({ message }) => {
        setStatus(message || "Action failed");
      });

      socketRef.current.on("room-state", ({ roomCode: incomingCode, isHost: hostFlag, videoId, isPlaying, currentTime, serverNow, chat }) => {
        if (incomingCode) setRoomCode(incomingCode);
        setIsHost(Boolean(hostFlag));
        const player = playerRef.current;
        if (!player) return;

        if (videoId) {
          const newVideo = findKnownVideo(videoId);
          setCurrentVideo(newVideo);
          setResultsMode("related");
          fetchRelated(videoId, newVideo.channelId || "");
          player.loadVideoById(videoId, 0);
        }

        setTimeout(() => {
          applyRemoteSync({ isPlaying, currentTime, serverNow }, { forceSeek: true });
        }, 200);

        setMessages((chat || []).map((m) => ({ ...m, kind: "chat" })));
        setStatus("Joined room");
        setJoined(true);
      });

      socketRef.current.on("room-owner-changed", ({ ownerSocketId }) => {
        const myId = socketRef.current?.id;
        setIsHost(Boolean(myId && ownerSocketId && myId === ownerSocketId));
      });

      socketRef.current.on("room-exited", () => {
        setJoined(false);
        setIsHost(false);
        setRoomCode("");
        setMessages([]);
        setStatus("You exited the room");
      });

      socketRef.current.on("room-terminated", ({ by }) => {
        setJoined(false);
        setIsHost(false);
        setRoomCode("");
        setMessages([]);
        setStatus(by ? `Room terminated by ${by}` : "Room terminated");
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

      socketRef.current.on("sync-play", ({ isPlaying, currentTime, serverNow }) => {
        applyRemoteSync({ isPlaying, currentTime, serverNow }, { forceSeek: true });
      });

      socketRef.current.on("sync-pause", ({ isPlaying, currentTime, serverNow }) => {
        applyRemoteSync({ isPlaying, currentTime, serverNow }, { forceSeek: true });
      });

      socketRef.current.on("sync-seek", ({ isPlaying, currentTime, serverNow }) => {
        applyRemoteSync({ isPlaying, currentTime, serverNow }, { forceSeek: true });
      });

      socketRef.current.on("sync-state", ({ isPlaying, currentTime, serverNow }) => {
        applyRemoteSync({ isPlaying, currentTime, serverNow });
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

  function exitRoom() {
    if (!joined || !socketRef.current) return;
    socketRef.current.emit("exit-room");
  }

  function terminateRoom() {
    if (!joined || !socketRef.current) return;
    socketRef.current.emit("terminate-room");
  }

  function scrollToPage(page) {
    const el = layoutRef.current;
    if (!el || !isMobileViewport) return;
    const firstPanel = el.querySelector(".panel");
    const styles = window.getComputedStyle(el);
    const gapValue = parseFloat(styles.columnGap || styles.gap || "0") || 0;
    const pitch = firstPanel ? firstPanel.getBoundingClientRect().width + gapValue : el.clientWidth;
    triggerHaptic([14]);
    el.scrollTo({
      left: page * pitch,
      behavior: "smooth",
    });
  }

  function handlePlayerStateChange() {
    if (!joined || !ready || !socketRef.current || !playerRef.current || !window.YT || suppressRef.current) return;

    const player = playerRef.current;
    const state = player.getPlayerState();
    const now = Date.now();
    const currentTime = Number(player.getCurrentTime() || 0);

    if (state === window.YT.PlayerState.PLAYING || state === window.YT.PlayerState.PAUSED) {
      const prev = lastSampleRef.current;
      if (prev.at > 0 && (prev.state === window.YT.PlayerState.PLAYING || prev.state === window.YT.PlayerState.PAUSED)) {
        const elapsed = (now - prev.at) / 1000;
        const expected = prev.time + (prev.state === window.YT.PlayerState.PLAYING ? elapsed : 0);
        const jump = Math.abs(currentTime - expected);
        if (jump > SEEK_JUMP_THRESHOLD && now - lastSeekEmitRef.current > SEEK_EMIT_COOLDOWN_MS) {
          lastSeekEmitRef.current = now;
          socketRef.current.emit("sync-seek", { currentTime });
        }
      }
      lastSampleRef.current = { time: currentTime, at: now, state };
    }

    if (state === lastStateRef.current) return;
    lastStateRef.current = state;

    if (state === window.YT.PlayerState.PLAYING) {
      socketRef.current.emit("sync-play", { currentTime });
    } else if (state === window.YT.PlayerState.PAUSED) {
      socketRef.current.emit("sync-pause", { currentTime });
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
        {joined ? (
          <div className="room-secondary-actions">
            <button type="button" className="secondary-btn" onClick={exitRoom}>Exit Room</button>
            <button
              type="button"
              className="danger-btn"
              onClick={terminateRoom}
              disabled={!isHost}
              title={isHost ? "Terminate room for all users" : "Only host can terminate room"}
            >
              Terminate Room
            </button>
          </div>
        ) : null}

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
