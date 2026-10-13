"""Move Yarn's focused runtime tree without nesting it under AVA's cache."""
import pathlib
import shutil
import sys


def prepare(root):
    root = pathlib.Path(root)
    source = root / "node_modules"
    destination = root / "packages/backend/server/node_modules"
    if source.is_symlink() or not source.is_dir():
        raise ValueError("Expected a real root node_modules directory")
    if destination.is_symlink():
        raise ValueError("Refusing a symlink at server node_modules")
    if destination.exists():
        # AVA creates this directory even when Yarn hoists all runtime packages.
        unexpected = sorted(p.name for p in destination.iterdir() if p.name != ".cache")
        if unexpected:
            raise ValueError(f"Unhoisted server dependencies require review: {unexpected}")
        cache = destination / ".cache"
        if cache.is_symlink():
            cache.unlink()
        elif cache.exists():
            shutil.rmtree(cache)
        destination.rmdir()
    source.rename(destination)


if __name__ == "__main__":
    prepare(sys.argv[1])
