"""Wrap the verified inner ELF in a bounded, static XZ launcher for QOS boot."""
import argparse
import lzma
import hashlib
import json
import os
import pathlib
import shutil
import struct


def digest(path):
    value = hashlib.sha256()
    with path.open('rb') as stream:
        while chunk := stream.read(65536):
            value.update(chunk)
    return value.hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ['launcher', 'runtime', 'output']:
        parser.add_argument('--' + name, type=pathlib.Path, required=True)
    args = parser.parse_args()
    if args.output.resolve() in [args.launcher.resolve(), args.runtime.resolve()]:
        parser.error('Output must differ from inputs')
    if not 0 < args.runtime.stat().st_size <= 256 * 1024 * 1024:
        raise RuntimeError('Inner runtime exceeds the extraction budget')
    temporary = args.output.with_name(args.output.name + '.tmp')
    try:
        with temporary.open('wb') as output:
            with args.launcher.open('rb') as source:
                shutil.copyfileobj(source, output)
            offset = output.tell()
            with lzma.LZMAFile(output, mode='wb', preset=6) as compressed:
                with args.runtime.open('rb') as source:
                    shutil.copyfileobj(source, compressed, 65536)
            length = output.tell() - offset
            output.write(b'OPENPOND_XZ_V1!!' + struct.pack('<QQQ', offset, length, args.runtime.stat().st_size))
            # Leave at least 1 MiB for the QOS manifest/envelope in its 128 MiB message.
            if output.tell() >= 127 * 1024 * 1024:
                raise RuntimeError('Compressed pivot exceeds the QOS boot budget')
        temporary.chmod(0o755)
        os.replace(temporary, args.output)
    finally:
        temporary.unlink(missing_ok=True)
    receipt = {'pivotBytes': args.output.stat().st_size, 'pivotSha256': digest(args.output),
               'runtimeBytes': args.runtime.stat().st_size, 'runtimeSha256': digest(args.runtime),
               'launcherSha256': digest(args.launcher), 'compression': 'xz', 'compressedOffset': offset, 'compressedBytes': length}
    args.output.with_suffix('.manifest.json').write_text(json.dumps(receipt, indent=2) + '\n')
    print(json.dumps(receipt))


if __name__ == '__main__':
    main()
