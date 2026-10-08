"""Append a static engine and one aligned, pinned GGUF to a packaged Node ELF."""
import argparse
import hashlib
import json
import os
import pathlib
import shutil
import struct

COMMIT = '5ad1c5da0ad7f6176256b823925aad19134f0263'
MODEL_SHA = '2e8040ceae7815abe0dcb3540b9995eaa1fa0d2ca9e797d0a635ae4433c68c2d'
MAGIC = b'OPENPOND_TVC_V1!'


def digest(path):
    value = hashlib.sha256()
    with path.open('rb') as stream:
        while chunk := stream.read(65536):
            value.update(chunk)
    return value.hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ['app', 'engine', 'model', 'output']:
        parser.add_argument('--' + name, required=True, type=pathlib.Path)
    args = parser.parse_args()
    if args.output.resolve() in [p.resolve() for p in [args.app, args.engine, args.model]]:
        parser.error('Output must differ from all inputs')
    if args.model.stat().st_size != 105454432 or digest(args.model) != MODEL_SHA:
        raise RuntimeError('The model does not match the pinned SmolLM2 135M Q4_K_M')
    for executable in [args.app, args.engine]:
        with executable.open('rb') as source:
            if source.read(4) != b'\x7fELF':
                raise RuntimeError(f'Not an ELF: {executable}')
    args.output.parent.mkdir(parents=True, exist_ok=True)
    temporary = args.output.with_name(args.output.name + '.tmp')
    manifest = {'schema': 1, 'llamaCommit': COMMIT}
    try:
        with temporary.open('wb') as target:
            with args.app.open('rb') as source:
                shutil.copyfileobj(source, target, 65536)
            for key, source_path in [('engine', args.engine), ('model', args.model)]:
                padding = (-target.tell()) % 4096
                target.write(b'\0' * padding)
                manifest[key] = {'offset': target.tell(), 'bytes': source_path.stat().st_size, 'sha256': digest(source_path)}
                with source_path.open('rb') as source:
                    shutil.copyfileobj(source, target, 65536)
            encoded = json.dumps(manifest, separators=(',', ':')).encode()
            target.write(encoded)
            target.write(MAGIC + struct.pack('<Q', len(encoded)))
        temporary.chmod(0o755)
        os.replace(temporary, args.output)
    finally:
        temporary.unlink(missing_ok=True)
    receipt = {**manifest, 'pivotBytes': args.output.stat().st_size, 'pivotSha256': digest(args.output)}
    args.output.with_suffix('.manifest.json').write_text(json.dumps(receipt, indent=2) + '\n')
    print(json.dumps(receipt))


if __name__ == '__main__':
    main()
