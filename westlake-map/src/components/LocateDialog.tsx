// "Where am I?" — read the room sign next to you with the phone camera.
//
// Indoors there is no GPS worth having, but every door in the school has its
// number on a sign, and the number says the floor too (100s lower, 200s main,
// 300s upper). So the camera is pointed at a sign, the frame is read with
// tesseract (loaded only when this opens; it is a few MB), and any three-digit
// token that names a room on the map is where you are. Typing the number is
// the same thing without the camera, and is always offered: a camera can be
// refused, missing, or simply worse than reading the sign yourself.

import { useEffect, useRef, useState } from "react";
import type { SearchItem } from "../lib/search";
import { resolvePlace } from "../lib/schedule";

interface Props {
  searchIndex: SearchItem[];
  onFound: (item: SearchItem) => void;
  onClose: () => void;
}

type Status = "starting" | "ready" | "reading" | "nocamera";

/** Every token on a sign that could be a room number, best-looking first. */
function roomFromText(index: SearchItem[], text: string): SearchItem | null {
  const tokens = text
    .toUpperCase()
    .replace(/[O]/g, "0")
    .match(/\b[0-9]{3}[A-Z]?\b/g);
  for (const t of tokens ?? []) {
    const hit = resolvePlace(index, t, null) ?? resolvePlace(index, t.slice(0, 3), null);
    if (hit) return hit;
  }
  return null;
}

export default function LocateDialog({ searchIndex, onFound, onClose }: Props) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [status, setStatus] = useState<Status>(() =>
    typeof navigator.mediaDevices?.getUserMedia === "function" ? "starting" : "nocamera"
  );
  const [typed, setTyped] = useState("");
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    let stream: MediaStream | null = null;
    let cancelled = false;
    if (typeof navigator.mediaDevices?.getUserMedia !== "function") return;
    navigator.mediaDevices
      .getUserMedia({ video: { facingMode: "environment" }, audio: false })
      .then((s) => {
        if (cancelled) {
          s.getTracks().forEach((t) => t.stop());
          return;
        }
        stream = s;
        if (videoRef.current) {
          videoRef.current.srcObject = s;
          void videoRef.current.play().catch(() => undefined);
        }
        setStatus("ready");
      })
      .catch(() => !cancelled && setStatus("nocamera"));
    return () => {
      cancelled = true;
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  async function readSign() {
    const video = videoRef.current;
    if (!video || !video.videoWidth) return;
    setStatus("reading");
    setMessage(null);
    // The middle of the frame, where the guide box is: a sign, not the hallway.
    const sw = video.videoWidth * 0.7;
    const sh = video.videoHeight * 0.4;
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(sw);
    canvas.height = Math.round(sh);
    canvas
      .getContext("2d")
      ?.drawImage(video, (video.videoWidth - sw) / 2, (video.videoHeight - sh) / 2, sw, sh, 0, 0, sw, sh);
    try {
      const { createWorker } = await import("tesseract.js");
      const worker = await createWorker("eng");
      await worker.setParameters({ tessedit_char_whitelist: "0123456789ABCDEFGHJKLMNPQRSTUVWXYZ " });
      const { data } = await worker.recognize(canvas);
      await worker.terminate();
      const hit = roomFromText(searchIndex, data.text);
      if (hit) {
        onFound(hit);
        return;
      }
      setMessage("Couldn't read a room number. Get closer to the sign, or type it below.");
    } catch {
      setMessage("The sign reader didn't load. Type the room number below.");
    }
    setStatus("ready");
  }

  function submitTyped(e: React.FormEvent) {
    e.preventDefault();
    const hit = roomFromText(searchIndex, typed) ?? resolvePlace(searchIndex, typed, null);
    if (hit) onFound(hit);
    else setMessage(`"${typed}" isn't a room on the map.`);
  }

  return (
    <div className="locate-backdrop" onClick={onClose}>
      <div
        className="locate-card"
        role="dialog"
        aria-modal="true"
        aria-label="Where am I?"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="panel-head">
          <p className="panel-title">Where am I?</p>
          <button className="panel-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        {status !== "nocamera" ? (
          <>
            <div className="locate-video">
              <video ref={videoRef} playsInline muted />
              <span className="locate-guide" aria-hidden="true" />
            </div>
            <p className="tool-hint">Point at the room number on the nearest door sign.</p>
            <button
              className="fly-btn primary locate-read"
              onClick={readSign}
              disabled={status !== "ready"}
            >
              {status === "starting" ? "Starting camera…" : status === "reading" ? "Reading…" : "Read the sign"}
            </button>
          </>
        ) : (
          <p className="tool-hint">No camera here. Type the number on the nearest door instead.</p>
        )}
        <form className="locate-type" onSubmit={submitTyped}>
          <input
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder="Room I'm next to, e.g. 214"
            inputMode="text"
            aria-label="Room I'm next to"
          />
          <button type="submit" className="fly-btn" disabled={!typed.trim()}>
            Go
          </button>
        </form>
        {message && (
          <p className="hint caution" role="status">
            {message}
          </p>
        )}
      </div>
    </div>
  );
}
