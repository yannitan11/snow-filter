// Snow Filter — webcam plumbing: permission flow, mirroring, lifecycle,
// front/rear switching, and graceful failure. The rest of the app only ever
// touches `feed.video` (a playing, muted, inline <video>) plus the lifecycle
// events below.

import { CAMERA } from "./config.js";

export const CAMERA_STATE = Object.freeze({
  idle: "idle",
  pending: "pending",
  live: "live",
  error: "error",
});

// Distinguish the failure modes the PRD calls out (§5.1) so the UI can show a
// useful message instead of a dead screen.
export function describeCameraError(err) {
  const name = err && err.name;
  if (name === "NotAllowedError" || name === "SecurityError")
    return "Camera permission was blocked. Enable it in your browser's site settings, then reload.";
  if (name === "NotFoundError" || name === "OverconstrainedError")
    return "No camera was found on this device.";
  if (name === "NotReadableError")
    return "The camera is in use by another app. Close it and try again.";
  return "We couldn't start the camera. Check your browser settings and try again.";
}

export class CameraFeed {
  constructor() {
    this.state = CAMERA_STATE.idle;
    this.facing = "user"; // 'user' (front) | 'environment' (rear)
    this.stream = null;
    this.video = document.createElement("video");
    this.video.playsInline = true; // iOS Safari: must not go fullscreen
    this.video.muted = true;
    this.video.autoplay = true;
    // Front camera is a selfie → mirror. Rear camera is not (§5.5 switch).
    this.mirrored = true;
  }

  get isFrontFacing() {
    return this.facing === "user";
  }

  async start(facing = this.facing) {
    this.state = CAMERA_STATE.pending;
    this.facing = facing;
    this.mirrored = facing === "user";
    this._stopStream();
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: facing, ...CAMERA },
        audio: false,
      });
      this.video.srcObject = this.stream;
      await this.video.play();
      await this._waitForMetadata();
      this.state = CAMERA_STATE.live;
      return true;
    } catch (err) {
      this.state = CAMERA_STATE.error;
      this.lastError = err;
      throw err;
    }
  }

  // Flip front/rear. Returns true on success; on failure restores the old side.
  async flip() {
    const next = this.facing === "user" ? "environment" : "user";
    const prev = this.facing;
    try {
      await this.start(next);
      return true;
    } catch {
      await this.start(prev).catch(() => {});
      return false;
    }
  }

  stop() {
    this._stopStream();
    this.state = CAMERA_STATE.idle;
  }

  _stopStream() {
    if (this.stream) {
      this.stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
    }
  }

  _waitForMetadata() {
    const v = this.video;
    if (v.readyState >= 2 && v.videoWidth) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        v.removeEventListener("loadeddata", done);
        resolve();
      };
      v.addEventListener("loadeddata", done);
    });
  }
}
