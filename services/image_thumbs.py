"""Downscaled, disk-cached preview thumbnails for the browser card grid.

A prompt card renders its preview at roughly 160-220 CSS px, but the stored
sidecar image is whatever the user saved (often 1024-1536 px tall). Browsers can
scale that down, but every paint then has to decode/scale the full bitmap, which
is what makes the grid expensive to repaint on a canvas that is scaled with
`transform: scale()`.

Cards therefore request `/pm4a/api/image?w=<px>` and this module serves a WebP
thumbnail that is generated once and cached next to the library index cache
(`<wildcards>/.pm4a/thumbs/<hash>-<width>.webp`). The cache key includes the
source mtime/size, so editing a preview image simply produces a new thumbnail.

The original file is still served for every request that does not ask for a
width, so detail views, metadata extraction and non-image clients are unchanged.
"""

from __future__ import annotations

import hashlib
import logging
import os
import secrets
import threading
from pathlib import Path
from typing import Any, Optional

try:
    from ..storage.library_metadata import metadata_dir
    from ..support.i18n import tr
except ImportError:  # standalone preview
    from storage.library_metadata import metadata_dir  # type: ignore
    from support.i18n import tr  # type: ignore

try:  # ComfyUI always ships Pillow, but never break the node package over it.
    from PIL import Image, ImageOps
except ImportError:  # pragma: no cover - exercised only on broken installs
    Image = None  # type: ignore[assignment]
    ImageOps = None  # type: ignore[assignment]

logger = logging.getLogger("ComfyUI4APromptManager")

THUMB_DIR_NAME = "thumbs"
THUMB_QUALITY = 82
THUMB_METHOD = 4
MIN_THUMB_WIDTH = 32
MAX_THUMB_WIDTH = 1024
#: Keep the cache bounded; thumbnails are ~10-40 KB each.
MAX_CACHE_FILES = 3000
PRUNE_EVERY = 64

_generate_lock = threading.Lock()
_misses_since_prune = 0
#: Cache keys that already failed to convert, so an unreadable sidecar image does not retry
#: (and log) on every single request. Bounded; a new mtime produces a new key.
failed_keys: set[str] = set()
MAX_FAILED_KEYS = 512


def thumb_root(library_root: Path) -> Path:
    """Directory that holds the generated thumbnails for one library root."""
    return metadata_dir(library_root) / THUMB_DIR_NAME


def clamp_width(raw: Any) -> Optional[int]:
    """Parse a `?w=` query value. Returns None when no thumbnail was requested."""
    if raw is None:
        return None
    text = str(raw).strip()
    if not text:
        return None
    try:
        width = int(float(text))
    except (TypeError, ValueError):
        return None
    if width <= 0:
        return None
    return max(MIN_THUMB_WIDTH, min(MAX_THUMB_WIDTH, width))


def cache_name(source: Path, width: int) -> str:
    stat = source.stat()
    digest = hashlib.sha1(
        f"{source.resolve()}|{stat.st_mtime_ns}|{stat.st_size}|{width}".encode("utf-8")
    ).hexdigest()
    return f"{digest[:20]}-{width}.webp"


def ensure_thumbnail(
    source: Path,
    width: int,
    library_root: Path,
) -> Optional[tuple[Path, str]]:
    """Return `(path, media_type)` for the thumbnail of `source`, or None.

    None means "serve the original": Pillow is missing, the image is unreadable,
    or it is already at most `width` pixels wide (re-encoding would only lose
    quality).
    """
    if Image is None:
        return None
    try:
        target = thumb_root(library_root) / cache_name(source, width)
    except OSError:
        return None
    if target.name in failed_keys:
        return None
    if target.is_file():
        return target, "image/webp"

    global _misses_since_prune
    with _generate_lock:
        if target.is_file():
            return target, "image/webp"
        try:
            with Image.open(source) as image:
                if image.size[0] <= width:
                    return None
                _write_thumbnail(image, width, target)
        except Exception as exc:
            _remember_failure(target.name)
            logger.warning("Could not build a %spx thumbnail for %s: %s", width, source, exc)
            return None
        _misses_since_prune += 1
        if _misses_since_prune >= PRUNE_EVERY:
            _misses_since_prune = 0
            _prune(thumb_root(library_root))
    return target, "image/webp"


def _write_thumbnail(image: "Image.Image", width: int, target: Path) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_name(f".{target.name}.{secrets.token_hex(6)}.tmp")
    try:
        # JPEG decoders can skip most of the pixels when only a small version is
        # needed; on large photos this is the difference between ~80 ms and ~8 ms.
        draft = getattr(image, "draft", None)
        if callable(draft):
            try:
                draft("RGB", (width * 2, width * 2))
            except Exception:  # pragma: no cover - format specific hint only
                pass
        # Browsers apply EXIF orientation to the original file, so the thumbnail has to
        # match it or imported phone photos would appear rotated in the grid.
        oriented = ImageOps.exif_transpose(image) if ImageOps is not None else image
        converted = oriented.convert("RGBA" if _has_alpha(oriented) else "RGB")
        converted.thumbnail((width, width * 4), Image.LANCZOS)
        converted.save(
            temporary,
            format="WEBP",
            quality=THUMB_QUALITY,
            method=THUMB_METHOD,
        )
        with Image.open(temporary) as check:
            check.load()
            if check.format != "WEBP" or check.size[0] > width:
                raise OSError(tr("缩略图生成校验失败"))
        os.replace(temporary, target)
    finally:
        temporary.unlink(missing_ok=True)


def _remember_failure(key: str) -> None:
    if len(failed_keys) >= MAX_FAILED_KEYS:
        failed_keys.clear()
    failed_keys.add(key)


def _has_alpha(image: "Image.Image") -> bool:
    if image.mode in {"RGBA", "LA"}:
        return True
    if image.mode == "P":
        return "transparency" in image.info
    return False


def _prune(directory: Path) -> None:
    """Drop the oldest thumbnails once the cache grows past its budget."""
    try:
        files = sorted(directory.glob("*.webp"), key=lambda path: path.stat().st_mtime)
    except OSError:
        return
    for path in files[: max(0, len(files) - MAX_CACHE_FILES)]:
        try:
            path.unlink()
        except OSError as exc:
            logger.debug("Could not prune thumbnail %s: %s", path, exc)


def clear_cache(library_root: Path) -> int:
    """Delete every cached thumbnail for a library root. Returns the file count."""
    directory = thumb_root(library_root)
    removed = 0
    try:
        for path in directory.glob("*.webp"):
            try:
                path.unlink()
                removed += 1
            except OSError:
                continue
    except OSError:
        return removed
    return removed
