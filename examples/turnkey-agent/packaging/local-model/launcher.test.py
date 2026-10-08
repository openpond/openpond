"""The extraction boundary must reject corruption and clean up on cancellation."""
import json
import pathlib
import shutil
import signal
import subprocess
import tempfile

HERE = pathlib.Path(__file__).resolve().parent
with tempfile.TemporaryDirectory(prefix='tvc-launcher-check-') as temporary:
    root = pathlib.Path(temporary)
    fixture = root / 'fixture.c'
    fixture.write_text('#include <stdio.h>\n#include <unistd.h>\nint main(int argc,char **argv){puts(argv[0]);fflush(stdout);if(argc>1)pause();return 0;}\n')
    subprocess.run(['cc', '-Os', '-static', str(fixture), '-o', str(root / 'runtime')], check=True)
    subprocess.run(['cc', '-Os', '-static', '-Wall', '-Wextra', '-Werror', str(HERE / 'launcher.c'), '-llzma', '-o', str(root / 'launcher')], check=True)
    subprocess.run(['python3', str(HERE / 'wrap.py'), '--launcher', str(root / 'launcher'), '--runtime', str(root / 'runtime'), '--output', str(root / 'pivot')], check=True, capture_output=True)
    receipt = json.loads((root / 'pivot.manifest.json').read_text())
    output = subprocess.run([str(root / 'pivot')], check=True, capture_output=True, text=True, timeout=10)
    extracted = pathlib.Path(output.stdout.strip())
    assert not extracted.exists() and not extracted.parent.exists(), 'Successful exit leaked payload'
    for name, offset in [('checksum', receipt['compressedOffset'] + receipt['compressedBytes'] // 2), ('footer', receipt['pivotBytes'] - 40)]:
        corrupt = root / name
        shutil.copyfile(root / 'pivot', corrupt); corrupt.chmod(0o700)
        with corrupt.open('r+b') as stream:
            stream.seek(offset); original = stream.read(1); stream.seek(offset); stream.write(bytes([original[0] ^ 255]))
        result = subprocess.run([str(corrupt)], capture_output=True, text=True, timeout=10)
        assert result.returncode != 0 and not result.stdout, 'Corrupt package executed the runtime'
    child = subprocess.Popen([str(root / 'pivot'), '--wait'], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    try:
        extracted = pathlib.Path(child.stdout.readline().strip())
        assert extracted.exists()
        child.send_signal(signal.SIGTERM)
        child.communicate(timeout=10)
        assert child.returncode != 0 and not extracted.parent.exists(), 'Cancellation leaked payload or child'
    finally:
        if child.poll() is None:
            child.kill(); child.communicate()
print('Launcher integrity, child exit and cancellation cleanup passed.')
