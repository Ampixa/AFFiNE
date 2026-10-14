"""Validate the release tree before privileged extraction. No devices or escaping links."""
import pathlib
import tarfile

MAX_EXPANDED = 4 * 1024**3
MAX_ENTRIES = 150_000

def validate(path):
    seen = {}
    total = 0
    with tarfile.open(path, "r:gz") as archive:
        for member in archive:
            name = pathlib.PurePosixPath(member.name)
            if name.is_absolute() or ".." in name.parts:
                raise ValueError("Unsafe archive path")
            normalized = str(name)
            if normalized in seen:
                raise ValueError("Duplicate archive path")
            if not (member.isfile() or member.isdir() or member.issym()):
                raise ValueError("Special files and hard links are forbidden")
            if member.issym():
                target = pathlib.PurePosixPath(member.linkname)
                if target.is_absolute():
                    raise ValueError("Absolute symlink")
                parts = list(name.parent.parts)
                for part in target.parts:
                    if part == "..":
                        if not parts:
                            raise ValueError("Escaping symlink")
                        parts.pop()
                    elif part != ".":
                        parts.append(part)
            seen[normalized] = member
            total += member.size
            if total > MAX_EXPANDED or len(seen) > MAX_ENTRIES:
                raise ValueError("Archive exceeds release limits")
        for name in seen:
            for parent in pathlib.PurePosixPath(name).parents:
                if str(parent) in seen and not seen[str(parent)].isdir():
                    raise ValueError("Archive member nested under a link or file")
    def resolve(parts):
        pending = list(parts)
        result = []
        links = 0
        while pending:
            part = pending.pop(0)
            if part in ("", "."):
                continue
            if part == "..":
                if not result:
                    raise ValueError("Transitive symlink escapes release")
                result.pop()
                continue
            candidate = "/".join(result + [part])
            member = seen.get(candidate)
            if member and member.issym():
                links += 1
                if links > 80:
                    raise ValueError("Symlink cycle")
                pending = list(pathlib.PurePosixPath(member.linkname).parts) + pending
            else:
                result.append(part)
        return result
    for name, member in seen.items():
        if member.issym():
            resolve(pathlib.PurePosixPath(name).parts)
    for required in ("SOURCE_COMMIT", "BUILD_VALIDATED", "FILES.sha256",
                     "RELEASE.json", "deploy.sh", "app/dist/main.js"):
        if required not in seen or not seen[required].isfile():
            raise ValueError("Missing release component: " + required)
    return total

if __name__ == "__main__":
    import sys
    print(validate(sys.argv[1]))
