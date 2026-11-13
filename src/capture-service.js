/**
 * Screenshot & Frame capture service for antigravity-desktop-mcp.
 *
 * Uses backend PowerShell worker + capture-exclusion wrapper, validates encoded image magic bytes,
 * maintains a bounded temp ring-buffer on disk (cleaning up older screenshots and on shutdown),
 * computes change digests per conversation, and formats MCP base64 image + text coordinate envelopes.
 */
import { createHash, randomBytes } from 'node:crypto';
import { copyFile, mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { screenshotEnvelope } from './internal/capture.mjs';
import { sessionKey as defaultSessionKey } from './internal/sessions.mjs';

const RING_LIMIT = 24;

/**
 * Inspect file header bytes to ensure delivered MIME type matches actual image bytes.
 */
export function detectImageMimeType(buf, fallback = 'image/png') {
  if (!buf || buf.length < 12) return fallback;
  // PNG: 89 50 4E 47
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  // JPEG: FF D8 FF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  // WebP: RIFF....WEBP
  if (buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return fallback;
}

function formatDisplaysSummary(shot) {
  if (typeof shot.displays === 'string' && shot.displays.trim()) return shot.displays.trim();
  const list = Array.isArray(shot.screens)
    ? shot.screens
    : (Array.isArray(shot.displays) ? shot.displays : []);
  if (list.length === 0) return '(unknown)';
  return list
    .map((d, idx) => {
      const i = d.index ?? idx;
      const prim = d.primary ? ' [primary]' : '';
      return `${i}: ${d.width ?? 0}x${d.height ?? 0} at (${d.x ?? 0},${d.y ?? 0})${prim}`;
    })
    .join('\n');
}

export class CaptureService {
  #captureDir;
  #tempFiles = [];
  #lastDigest = new Map();
  #captureExclusion;
  #getVisualGeneration;

  constructor({ captureDir, captureExclusion = null, getVisualGeneration = () => null } = {}) {
    this.#captureDir = captureDir;
    this.#captureExclusion = captureExclusion;
    this.#getVisualGeneration = typeof getVisualGeneration === 'function' ? getVisualGeneration : () => null;
  }

  /**
   * Allocate a unique temp path under captureDir, pruning oldest ring-buffer entries above RING_LIMIT.
   */
  async nextCapturePath(ext = 'png') {
    await mkdir(this.#captureDir, { recursive: true });
    const filePath = join(this.#captureDir, `shot-${Date.now()}-${randomBytes(4).toString('hex')}.${ext}`);
    this.#tempFiles.push(filePath);
    while (this.#tempFiles.length > RING_LIMIT) {
      const oldest = this.#tempFiles.shift();
      if (oldest) {
        await rm(oldest, { force: true }).catch(() => { /* ignore */ });
      }
    }
    return filePath;
  }

  /**
   * Run capture function under overlay exclusion (if hardware WDA_EXCLUDEFROMCAPTURE is unsupported).
   */
  async withCaptureExclusion(fn) {
    if (!this.#captureExclusion) return fn();
    const token = await this.#captureExclusion.begin(this.#getVisualGeneration());
    try {
      return await fn();
    } finally {
      await this.#captureExclusion.end(token);
    }
  }

  /**
   * Read the captured file from disk, check SHA-256 unchanged status, optionally copy to `savePath`,
   * and prepare MCP content blocks `{ imageContent, meta, value, envelopeText }`.
   */
  async prepareShotResult(shot, { sessionId = 'default', savePath = '', name = 'desktop_screenshot' } = {}) {
    if (!shot || !shot.path) {
      throw new Error('capture backend returned no output path');
    }
    const bytes = await readFile(shot.path);
    const mimeType = detectImageMimeType(
      bytes,
      String(shot.format ?? '').toLowerCase() === 'jpeg' ? 'image/jpeg' : 'image/png',
    );
    const digest = createHash('sha256').update(bytes).digest('hex');
    const sKey = defaultSessionKey(sessionId);
    const prev = this.#lastDigest.get(sKey);
    const unchanged = prev !== undefined && prev === digest;
    this.#lastDigest.set(sKey, digest);

    if (savePath) {
      await mkdir(join(savePath, '..'), { recursive: true }).catch(() => { /* root or existing */ });
      await copyFile(shot.path, savePath);
    }

    const encodedWidth = Number(shot.encodedWidth ?? shot.imageWidth ?? shot.width ?? 0);
    const encodedHeight = Number(shot.encodedHeight ?? shot.imageHeight ?? shot.height ?? 0);
    const frameId = String(shot.frame ?? shot.frameId ?? '');
    const activeWindow = String(shot.activeWindow ?? shot.foreground?.title ?? shot.window?.title ?? '');
    const deliveredPath = savePath || shot.path;

    const value = {
      frame: frameId,
      frameId: frameId || undefined,
      path: deliveredPath,
      file: deliveredPath,
      x: Number(shot.x ?? 0),
      y: Number(shot.y ?? 0),
      width: Number(shot.width ?? encodedWidth),
      height: Number(shot.height ?? encodedHeight),
      scale: Number(shot.effectiveScale ?? shot.scale ?? 1),
      imageWidth: encodedWidth,
      imageHeight: encodedHeight,
      encodedWidth,
      encodedHeight,
      format: mimeType === 'image/jpeg' ? 'jpeg' : 'png',
      bytes: bytes.byteLength,
      unchanged,
      cursor: shot.cursor ?? { x: 0, y: 0 },
      activeWindow,
      displays: formatDisplaysSummary(shot),
      source: shot.source,
      surfaceKind: shot.surfaceKind,
      crop: shot.cropRectSurface ?? shot.crop,
      scaleNote: shot.scaleNote,
      verification: shot.verification,
      stability: shot.stability,
      timing: shot.timing,
      window: shot.window ?? undefined,
      surface: shot.surface ?? undefined,
      clipped: shot.clipped === true,
      note: shot.note ?? undefined,
    };

    const envelopeText = screenshotEnvelope(value);
    return {
      imageContent: {
        type: 'image',
        data: bytes.toString('base64'),
        mimeType,
      },
      envelopeText,
      value,
      meta: {
        frameId: value.frameId,
        width: value.width,
        height: value.height,
        encodedWidth: value.encodedWidth,
        encodedHeight: value.encodedHeight,
        x: value.x,
        y: value.y,
        scale: value.scale,
        bytes: value.bytes,
        mimeType,
        unchanged,
        name,
        savedTo: savePath || undefined,
      },
    };
  }

  /**
   * Clean up temporary capture directory on MCP shutdown.
   */
  async dispose() {
    this.#tempFiles = [];
    this.#lastDigest.clear();
    await rm(this.#captureDir, { recursive: true, force: true }).catch(() => { /* best effort */ });
  }
}
