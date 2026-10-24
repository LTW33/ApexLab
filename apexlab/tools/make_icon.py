"""Generate a 256x256 ApexLab icon (ICO with an embedded PNG) without dependencies."""
from __future__ import annotations

import struct
import zlib
from pathlib import Path

import numpy as np

SIZE = 256


def _rounded_rect_mask(size: int, radius: float) -> np.ndarray:
    yy, xx = np.mgrid[0:size, 0:size].astype(np.float64)
    cx = np.clip(xx, radius, size - 1 - radius)
    cy = np.clip(yy, radius, size - 1 - radius)
    dist = np.hypot(xx - cx, yy - cy)
    return np.clip(radius + 0.5 - dist, 0.0, 1.0)


def _polyline_distance(points: list[tuple[float, float]], thickness: float) -> np.ndarray:
    yy, xx = np.mgrid[0:SIZE, 0:SIZE].astype(np.float64)
    best = np.full((SIZE, SIZE), 1e9)
    for (x0, y0), (x1, y1) in zip(points, points[1:]):
        vx, vy = x1 - x0, y1 - y0
        length2 = vx * vx + vy * vy or 1.0
        t = np.clip(((xx - x0) * vx + (yy - y0) * vy) / length2, 0.0, 1.0)
        d = np.hypot(xx - (x0 + vx * t), yy - (y0 + vy * t))
        best = np.minimum(best, d)
    for x, y in (points[0], points[-1]):
        best = np.minimum(best, np.hypot(xx - x, yy - y))
    return np.clip(thickness + 0.5 - best, 0.0, 1.0)


def build() -> np.ndarray:
    bg = np.zeros((SIZE, SIZE, 4), dtype=np.float64)
    bg[..., 0] = 12
    bg[..., 1] = 14
    bg[..., 2] = 17
    bg[..., 3] = 255

    # subtle vertical gradient
    grad = np.linspace(0.0, 1.0, SIZE)[:, None, None]
    bg[..., 0] += 10 * grad[..., 0]
    bg[..., 1] += 12 * grad[..., 0]
    bg[..., 2] += 14 * grad[..., 0]

    # lime racing line: entry -> apex -> exit
    line = [
        (44.0, 176.0), (72.0, 186.0), (104.0, 170.0),
        (136.0, 118.0), (168.0, 82.0), (206.0, 76.0),
    ]
    mask = _polyline_distance(line, 13.0)

    # dim ghost line for the reference
    ghost = _polyline_distance(
        [(44.0, 208.0), (86.0, 198.0), (120.0, 168.0), (156.0, 150.0), (206.0, 138.0)],
        5.0,
    )

    # apex marker
    yy, xx = np.mgrid[0:SIZE, 0:SIZE].astype(np.float64)
    apex = np.clip(17.0 + 0.5 - np.hypot(xx - 136.0, yy - 118.0), 0.0, 1.0)

    out = bg.copy()
    ghost_rgb = np.array([120.0, 132.0, 140.0])
    ghost_a = ghost * 0.45
    out[..., :3] = out[..., :3] * (1 - ghost_a[..., None]) + ghost_rgb * ghost_a[..., None]

    lime = np.array([200.0, 255.0, 61.0])
    out[..., :3] = out[..., :3] * (1 - mask[..., None]) + lime * mask[..., None]

    # dark core of the apex dot with a lime rim
    out[..., :3] = out[..., :3] * (1 - apex[..., None]) + np.array([12.0, 14.0, 17.0]) * apex[..., None]
    rim = np.clip(np.abs(np.hypot(xx - 136.0, yy - 118.0) - 8.0) < 2.0, 0, 1).astype(np.float64)
    out[..., :3] = out[..., :3] * (1 - rim[..., None]) + lime * rim[..., None]

    alpha = _rounded_rect_mask(SIZE, 56.0)
    out[..., 3] *= alpha
    return out.clip(0, 255).astype(np.uint8)


def png_bytes(rgba: np.ndarray) -> bytes:
    h, w, _ = rgba.shape
    raw = b"".join(b"\x00" + rgba[y].tobytes() for y in range(h))

    def chunk(tag: bytes, data: bytes) -> bytes:
        return (struct.pack(">I", len(data)) + tag + data
                + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))

    header = struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0)
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header)
            + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b""))


def ico_bytes(png: bytes, size: int) -> bytes:
    entry = struct.pack("<BBBBHHII", 0, 0, 0, 0, 1, 32, len(png), 22)
    return struct.pack("<HHH", 0, 1, 1) + entry + png


def main() -> None:
    import sys
    target = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("build/apexlab.ico")
    target.parent.mkdir(parents=True, exist_ok=True)
    rgba = build()
    target.write_bytes(ico_bytes(png_bytes(rgba), SIZE))
    print(f"icon -> {target} ({target.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
