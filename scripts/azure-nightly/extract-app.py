import os
from pathlib import Path, PurePosixPath
import stat
import sys
import zipfile


def extract_app(archive, destination):
    app_name = "T3 Code (Azure Nightly).app"
    destination = Path(destination).resolve()
    entries = []
    total = 0
    with zipfile.ZipFile(archive) as bundle:
        for entry in bundle.infolist():
            parts = PurePosixPath(entry.filename).parts
            if not parts or parts[0] != app_name or ".." in parts or entry.filename.startswith("/") or "\\" in entry.filename:
                if parts and parts[0] == "__MACOSX":
                    continue
                raise ValueError("Invalid application archive path")
            total += entry.file_size
            if total > 8 * 1024**3 or len(entries) > 200000:
                raise ValueError("Application archive exceeds limits")
            mode = entry.external_attr >> 16
            if stat.S_ISLNK(mode):
                link = bundle.read(entry).decode("utf-8")
                if os.path.isabs(link) or "\\" in link:
                    raise ValueError("Absolute application symlink")
                target = os.path.normpath(str(PurePosixPath(*parts).parent / link))
                if not target.startswith(app_name + "/"):
                    raise ValueError("Escaping application symlink")
                entries.append((entry, parts, mode, link))
            elif entry.is_dir() or stat.S_ISREG(mode) or mode & stat.S_IFMT(mode) == 0:
                entries.append((entry, parts, mode, None))
            else:
                raise ValueError("Unsupported application archive member")
        paths = [parts for _, parts, _, _ in entries]
        if len(paths) != len(set(paths)):
            raise ValueError("Duplicate application archive member")
        links = {parts for _, parts, _, link in entries if link is not None}
        for parts in paths:
            if any(parts[:index] in links for index in range(1, len(parts))):
                raise ValueError("Archive member is below a symlink")
        destination.mkdir(mode=0o700, parents=True, exist_ok=False)
        for entry, parts, mode, link in sorted(entries, key=lambda item: item[3] is not None):
            target = destination.joinpath(*parts)
            target.parent.mkdir(parents=True, exist_ok=True)
            if link is not None:
                target.symlink_to(link)
            elif entry.is_dir():
                target.mkdir(exist_ok=True)
            else:
                with target.open("xb") as output:
                    output.write(bundle.read(entry))
                target.chmod(mode & 0o777)


if __name__ == "__main__":
    extract_app(sys.argv[1], sys.argv[2])
