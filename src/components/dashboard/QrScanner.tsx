"use client";

import jsQR from "jsqr";
import { useEffect, useRef, useState } from "react";

/**
 * Staff Scan flow (§33 Phase 3) camera UI. Uses the native `getUserMedia`/`<video>`/`<canvas>`
 * APIs directly + `jsqr` (pure decode function, zero dependencies) rather than an all-in-one
 * camera-scanning framework — see the Phase 3 dependency-review note in `src/modules/points/qr.ts`
 * for why `jsqr` was chosen. On a successful decode, calls `onDecode(value)` once and stops.
 *
 * Known limitation: camera access can't be exercised in this repo's automated test suite (no
 * camera in the emulator/CI environment) — the decode→lookup path it feeds into
 * (`getMembershipByCode`) is fully tested independently.
 */
export function QrScanner({ onDecode }: { onDecode: (value: string) => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState(false);

  useEffect(() => {
    if (!active) return;
    let stream: MediaStream | undefined;
    let frameId: number;
    let stopped = false;

    async function start() {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
      } catch {
        setError("ไม่สามารถเข้าถึงกล้องได้ — กรุณาอนุญาตการใช้กล้อง");
        return;
      }
      if (!videoRef.current) return;
      videoRef.current.srcObject = stream;
      await videoRef.current.play();
      tick();
    }

    function tick() {
      if (stopped) return;
      const video = videoRef.current;
      const canvas = canvasRef.current;
      if (video && canvas && video.readyState === video.HAVE_ENOUGH_DATA) {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        const ctx = canvas.getContext("2d");
        if (ctx) {
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
          const code = jsQR(imageData.data, imageData.width, imageData.height);
          if (code?.data) {
            stopped = true;
            onDecode(code.data);
            return;
          }
        }
      }
      frameId = requestAnimationFrame(tick);
    }

    start();
    return () => {
      stopped = true;
      if (frameId) cancelAnimationFrame(frameId);
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [active, onDecode]);

  if (!active) {
    return (
      <button type="button" onClick={() => setActive(true)} className="rounded border px-4 py-2 text-sm">
        เปิดกล้องสแกน QR
      </button>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {error ? <p className="text-sm text-red-700">{error}</p> : null}
      <video ref={videoRef} muted playsInline className="w-full max-w-xs rounded border" />
      <canvas ref={canvasRef} className="hidden" />
      <button type="button" onClick={() => setActive(false)} className="w-fit text-xs underline">
        ปิดกล้อง
      </button>
    </div>
  );
}
