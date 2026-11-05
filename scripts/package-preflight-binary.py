"""Package a static Linux checker reproducibly, with its installation digest."""
import argparse
import gzip
import hashlib
import io
import json
from pathlib import Path
import re
import struct
import tarfile


TARGETS = {
    "amd64": (62, "x86_64-unknown-linux-musl"),
    "arm64": (183, "aarch64-unknown-linux-musl"),
}


def verify_elf(data, architecture):
    if len(data) < 64 or data[:6] != b"\x7fELF\x02\x01":
        raise ValueError("checker must be a little-endian 64-bit Linux ELF")
    if struct.unpack_from("<H", data, 18)[0] != TARGETS[architecture][0]:
        raise ValueError("checker ELF architecture does not match the archive")
    offset = struct.unpack_from("<Q", data, 32)[0]
    size, count = struct.unpack_from("<HH", data, 54)
    if size < 56 or count == 0 or offset + size * count > len(data):
        raise ValueError("invalid ELF program headers")
    for index in range(count):
        header = offset + size * index
        kind = struct.unpack_from("<I", data, header)[0]
        if kind == 3:  # PT_INTERP means an external dynamic loader is required.
            raise ValueError("checker must be statically linked")
        if kind == 2:  # Static PIE may have PT_DYNAMIC, but no DT_NEEDED entries.
            start = struct.unpack_from("<Q", data, header + 8)[0]
            length = struct.unpack_from("<Q", data, header + 32)[0]
            if length % 16 or start + length > len(data):
                raise ValueError("invalid ELF dynamic section")
            for position in range(start, start + length, 16):
                tag = struct.unpack_from("<q", data, position)[0]
                if tag == 0:
                    break
                if tag == 1:
                    raise ValueError("checker requires a shared library")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--binary", type=Path, required=True)
    parser.add_argument("--architecture", choices=TARGETS, required=True)
    parser.add_argument("--revision", required=True)
    parser.add_argument("--epoch", type=int, required=True)
    parser.add_argument("--rustc-version", required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    version = json.loads((root / "package.json").read_text())["version"]
    if not re.fullmatch(r"[0-9A-Za-z.+-]+", version):
        parser.error("invalid package version")
    if not re.fullmatch(r"[0-9a-f]{40}|[0-9a-f]{64}", args.revision):
        parser.error("revision must be a full Git commit hash")
    if not 0 <= args.epoch <= 0o77777777777:
        parser.error("epoch is outside the tar timestamp range")
    binary = args.binary.read_bytes()
    try:
        verify_elf(binary, args.architecture)
    except ValueError as error:
        parser.error(str(error))
    digest = hashlib.sha256(binary).hexdigest()
    metadata = {
        "schemaVersion": 1,
        "version": version,
        "revision": args.revision,
        "target": TARGETS[args.architecture][1],
        "linkage": "static-musl",
        "rustcVersion": args.rustc_version,
        "sourceDateEpoch": args.epoch,
        "checkerSHA256": digest,
    }
    entries = {
        "krab-preflight": binary,
        "LICENSE": (root / "LICENSE").read_bytes(),
        "README.md": (root / "preflight/RELEASE-README.md").read_text()
            .replace("@VERSION@", version).replace("@REVISION@", args.revision).encode(),
        "SHA256SUMS": f"{digest}  krab-preflight\n".encode(),
        "BUILD-INFO.json": (json.dumps(metadata, indent=2, sort_keys=True) + "\n").encode(),
    }
    args.output.mkdir(parents=True, exist_ok=True)
    path = args.output / f"krab-preflight-{version}-linux-{args.architecture}.tar.gz"
    with path.open("wb") as output:
        with gzip.GzipFile(filename="", fileobj=output, mode="wb", mtime=0) as compressed:
            with tarfile.open(fileobj=compressed, mode="w", format=tarfile.USTAR_FORMAT) as archive:
                for name, content in sorted(entries.items()):
                    info = tarfile.TarInfo(name)
                    info.size = len(content)
                    info.mode = 0o755 if name == "krab-preflight" else 0o644
                    info.mtime = args.epoch
                    info.uname = info.gname = "root"
                    archive.addfile(info, io.BytesIO(content))
    print(path)


if __name__ == "__main__":
    main()
