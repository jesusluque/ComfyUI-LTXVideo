"""Server-side file browser for path-based LTX nodes (fork addition).

Exposes ``GET /ltxv/browse?path=<dir>&exts=exr,png`` so the frontend can let users
pick a file or folder on the ComfyUI *server* (e.g. a shared filespace mounted under
``/mnt``) instead of typing absolute paths by hand.

Browsing is confined to a set of allowed roots: ComfyUI's input and output folders
plus ``LTXV_BROWSE_ROOTS`` (colon-separated, default ``/mnt``). Anything outside
them is refused, so the endpoint cannot be used to list arbitrary system folders.
"""

from __future__ import annotations

import os

DEFAULT_EXTS = {".exr"}


def _allowed_roots() -> list[str]:
    roots = []
    try:
        import folder_paths

        roots += [folder_paths.get_input_directory(), folder_paths.get_output_directory()]
    except Exception:
        pass
    extra = os.environ.get("LTXV_BROWSE_ROOTS", "/mnt")
    roots += [r for r in extra.split(":") if r]
    out = []
    for r in roots:
        try:
            out.append(os.path.realpath(r))
        except Exception:
            continue
    return out


def _inside(path: str, roots: list[str]) -> bool:
    for r in roots:
        try:
            if os.path.commonpath((r, path)) == r:
                return True
        except ValueError:
            continue
    return False


def _register() -> None:
    from aiohttp import web
    from server import PromptServer

    instance = getattr(PromptServer, "instance", None)
    if instance is None:
        return

    @instance.routes.get("/ltxv/browse")
    async def ltxv_browse(request):
        roots = _allowed_roots()
        raw = request.query.get("path") or (roots[-1] if roots else "/")
        exts = request.query.get("exts")
        allow = (
            {"." + e.strip().lower().lstrip(".") for e in exts.split(",") if e.strip()}
            if exts
            else DEFAULT_EXTS
        )
        path = os.path.realpath(raw)
        if not _inside(path, roots):
            return web.json_response(
                {"error": "path outside the allowed folders", "path": path,
                 "roots": roots, "dirs": [], "files": []},
                status=403,
            )
        try:
            entries = list(os.scandir(path))
        except Exception as exc:  # unreadable / missing folder
            return web.json_response(
                {"error": str(exc), "path": path, "parent": os.path.dirname(path),
                 "roots": roots, "dirs": [], "files": []}
            )
        dirs, files = [], []
        for e in entries:
            if e.name.startswith("."):
                continue
            try:
                if e.is_dir():
                    dirs.append(e.name)
                elif os.path.splitext(e.name)[1].lower() in allow:
                    files.append(e.name)
            except OSError:
                pass
        dirs.sort(key=str.lower)
        files.sort()
        parent = os.path.dirname(path)
        return web.json_response(
            {"path": path, "parent": parent if _inside(parent, roots) else None,
             "roots": roots, "dirs": dirs, "files": files}
        )


try:
    _register()
except Exception:  # outside ComfyUI (tests, CLI) or API changes: never break the pack
    pass
