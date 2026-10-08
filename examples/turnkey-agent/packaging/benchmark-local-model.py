"""Real CPU inference under an externally imposed Linux cgroup memory limit.

Run in a fresh systemd user unit with MemoryMax=1G and MemorySwapMax=0.
The model is copied to tmpfs inside the unit so its pages count toward the cap.
The bounded local hash fixture executes sha256sum; it is not Firecracker or TVC.
"""
import argparse
import base64
import hashlib
import http.server
import json
import os
import pathlib
import re
import selectors
import shutil
import socket
import subprocess
import tempfile
import threading
import time
import urllib.request


def request(url, body=None, headers=None, timeout=310):
    data = None if body is None else json.dumps(body).encode()
    with urllib.request.urlopen(urllib.request.Request(url, data=data, headers=headers or {}), timeout=timeout) as response:
        return json.load(response)


def free_port():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--model', required=True, type=pathlib.Path)
    parser.add_argument('--llama-server', required=True, type=pathlib.Path)
    artifact = parser.add_mutually_exclusive_group(required=True)
    artifact.add_argument('--executable', type=pathlib.Path)
    artifact.add_argument('--bundle', type=pathlib.Path)
    parser.add_argument('--output', required=True, type=pathlib.Path)
    parser.add_argument('--kv', default='q8_0', choices=['q8_0', 'q4_0'])
    parser.add_argument('--batch', default=128, type=int)
    parser.add_argument('--tool-runs', default=3, type=int)
    args = parser.parse_args()
    if not 1 <= args.tool_runs <= 20 or not 1 <= args.batch <= 1024:
        parser.error('tool-runs must be 1..20 and batch must be 1..1024')
    args.output.mkdir(parents=True, exist_ok=True)
    group = next(line[3:] for line in pathlib.Path('/proc/self/cgroup').read_text().splitlines() if line.startswith('0::'))
    cgroup = pathlib.Path('/sys/fs/cgroup') / group.lstrip('/')
    limits = {key: (cgroup / key).read_text().strip() for key in ['memory.max', 'memory.swap.max']}
    if limits != {'memory.max': '1073741824', 'memory.swap.max': '0'}:
        raise RuntimeError(f'Requires fresh 1 GiB cgroup, swap disabled: {limits}')
    result = {'location': 'local Linux, not TVC', 'limits': limits, 'contextTokens': 4096,
              'kvCache': args.kv, 'batch': args.batch, 'threads': 2, 'turns': [],
              'modelFileBytes': args.model.stat().st_size, 'hashFixtureExecutions': 0,
              'sandbox': 'local sha256sum HTTP fixture, not Firecracker', 'samples': {}}
    def memory_sample(label):
        result['samples'][label] = {key: int((cgroup / key).read_text()) for key in ['memory.current', 'memory.peak']}
        stats = dict(line.split() for line in (cgroup / 'memory.stat').read_text().splitlines())
        result['samples'][label]['stat'] = {key: int(stats[key]) for key in ['anon', 'file', 'shmem', 'file_mapped']}
        result['samples'][label]['events'] = (cgroup / 'memory.events').read_text()
    for label, source in [('app', args.executable or args.bundle), ('llamaServer', args.llama_server)]:
        digest = hashlib.sha256()
        with source.open('rb') as stream:
            while chunk := stream.read(65536):
                digest.update(chunk)
        result[label + 'Artifact'] = {'path': str(source.resolve()), 'sha256': digest.hexdigest(), 'bytes': source.stat().st_size}
    children, logs = [], []
    stop = threading.Event()
    peaks = {}

    def sample():
        while not stop.wait(.02):
            try:
                peaks['combinedCgroup'] = max(peaks.get('combinedCgroup', 0), int((cgroup / 'memory.current').read_text()))
            except OSError:
                pass
            for name, child in children[:]:
                try:
                    status = pathlib.Path(f'/proc/{child.pid}/status').read_text()
                    size = int(re.search(r'^VmRSS:\s+(\d+)', status, re.M)[1]) * 1024
                    peaks[name] = max(peaks.get(name, 0), size)
                except (OSError, TypeError):
                    pass

    sampler = threading.Thread(target=sample, daemon=True)
    sampler.start()
    fixture = None
    try:
        with tempfile.TemporaryDirectory(prefix='openpond-model-', dir='/dev/shm') as model_dir, tempfile.TemporaryDirectory(prefix='openpond-inference-') as scratch:
            staged = pathlib.Path(model_dir) / 'model.gguf'
            digest = hashlib.sha256()
            with args.model.open('rb') as source, staged.open('wb') as target:
                while chunk := source.read(65536):
                    digest.update(chunk)
                    target.write(chunk)
            result['modelSha256'] = digest.hexdigest()
            memory_sample('modelStaged')
            model_port = free_port()
            command = [str(args.llama_server.resolve()), '--model', str(staged), '--host', '127.0.0.1', '--port', str(model_port),
                       '--ctx-size', '4096', '--parallel', '1', '--threads', '2', '--threads-http', '2',
                       '--batch-size', str(args.batch), '--ubatch-size', str(args.batch), '--cache-type-k', args.kv,
                       '--cache-type-v', args.kv, '--no-repack', '--cache-ram', '0', '--n-gpu-layers', '0',
                       '--flash-attn', 'on', '--reasoning', 'off', '--chat-template-kwargs', '{"enable_thinking":false}']
            result['modelCommand'] = command
            log = (args.output / 'model.log').open('w'); logs.append(log)
            model_started = time.monotonic()
            model = subprocess.Popen(command, stdout=log, stderr=log)
            children.append(('model', model))
            deadline = time.monotonic() + 90
            while True:
                if model.poll() is not None:
                    raise RuntimeError(f'Model exited: {model.returncode}')
                try:
                    request(f'http://127.0.0.1:{model_port}/health', timeout=1)
                    break
                except Exception:
                    if time.monotonic() > deadline:
                        raise TimeoutError('Model startup')
                    time.sleep(.1)

            result['modelStartupSeconds'] = round(time.monotonic() - model_started, 3)
            memory_sample('modelReady')

            class Fixture(http.server.BaseHTTPRequestHandler):
                def log_message(self, *_):
                    pass

                def do_GET(self):
                    self.handle_request()

                def do_POST(self):
                    self.handle_request()

                def handle_request(self):
                    try:
                        assert self.headers.get('openpond-api-key') == 'local-fixture'
                        sandbox = {'id': 'fixture', 'teamId': 'fixture-team'}
                        value = {'sandbox': sandbox}
                        if self.command == 'POST':
                            assert self.path == '/sandboxes/fixture/exec'
                            length = int(self.headers['content-length'])
                            assert 0 < length <= 65536
                            body = json.loads(self.rfile.read(length))
                            match = re.fullmatch(r"printf '%s' '([A-Za-z0-9+/=]*)' \| base64 -d \| sha256sum", body['command'])
                            assert match and body['timeoutSeconds'] == 15
                            raw = base64.b64decode(match[1], validate=True)
                            assert len(raw) <= 16384
                            output = subprocess.check_output(['sha256sum'], input=raw, timeout=15).decode()
                            result['hashFixtureExecutions'] += 1
                            value['command'] = {'id': f"local-{result['hashFixtureExecutions']}", 'status': 'succeeded', 'exitCode': 0, 'output': output}
                        else:
                            assert self.path == '/sandboxes/fixture'
                        encoded = json.dumps(value).encode()
                        self.send_response(200); self.send_header('content-type', 'application/json'); self.end_headers(); self.wfile.write(encoded)
                    except Exception as error:
                        self.send_error(500, str(error))

            fixture = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Fixture)
            threading.Thread(target=fixture.serve_forever, daemon=True).start()
            config = {'host': '127.0.0.1', 'port': 0, 'authTokenSha256': hashlib.sha256(b'local-model-test').hexdigest(),
                      'modelEndpoint': f'http://127.0.0.1:{model_port}/v1', 'model': 'local', 'requestTimeoutMs': 300000,
                      'sandboxEndpoint': f'http://127.0.0.1:{fixture.server_port}/sandboxes', 'sandboxId': 'fixture', 'sandboxTeamId': 'fixture-team'}
            command = [str(args.executable.resolve())] if args.executable else [shutil.which('node'), str(args.bundle.resolve())]
            log = (args.output / 'app.log').open('w'); logs.append(log)
            app_started = time.monotonic()
            app = subprocess.Popen(command + ['--config-json', json.dumps(config)], cwd=scratch,
                                   env={'PATH': os.environ['PATH'], 'HOME': scratch, 'TMPDIR': scratch}, stdout=subprocess.PIPE, stderr=log, text=True)
            children.append(('app', app))
            with selectors.DefaultSelector() as selector:
                selector.register(app.stdout, selectors.EVENT_READ)
                deadline = time.monotonic() + 60
                while time.monotonic() < deadline:
                    if app.poll() is not None:
                        raise RuntimeError(f'App exited: {app.returncode}')
                    if selector.select(.1):
                        try:
                            event = json.loads(app.stdout.readline())
                        except ValueError:
                            continue
                        if event.get('status') == 'listening':
                            break
                else:
                    raise TimeoutError('App startup')
            result['appStartupSeconds'] = round(time.monotonic() - app_started, 3)
            memory_sample('appReady')
            for index in range(args.tool_runs + 1):
                text = f'OpenPond local model baseline {index}'
                expected = hashlib.sha256(text.encode()).hexdigest()
                prompt = 'Reply with exactly OK. Do not call any tools.' if index == 0 else f'Use sandbox_sha256 once to compute SHA-256 of the exact UTF-8 text {json.dumps(text)}. Report the tool\'s hash.'
                started = time.monotonic()
                response = request(f'http://127.0.0.1:{event["port"]}/chat', {'prompt': prompt, 'credentials': {'modelApiKey': 'local', 'sandboxApiKey': 'local-fixture'}}, {'authorization': 'Bearer local-model-test', 'content-type': 'application/json'})
                turn = {'kind': 'plain' if index == 0 else 'tool', 'seconds': round(time.monotonic() - started, 3), 'response': response}
                result['turns'].append(turn)
                memory_sample(f'turn{index}')
                if index:
                    assert expected in response['answer'], response
                    assert any(tool.get('sha256') == expected for tool in response['tools']), response
                    assert result['hashFixtureExecutions'] == index
                else:
                    assert response['answer'].strip().rstrip('.') == 'OK', response
                print(json.dumps(turn), flush=True)
            result['passed'] = True
    except Exception as error:
        result['passed'] = False
        result['error'] = repr(error)
    finally:
        for _, child in reversed(children):
            child.terminate()
            try:
                child.wait(timeout=5)
            except subprocess.TimeoutExpired:
                child.kill(); child.wait()
        if fixture:
            fixture.shutdown(); fixture.server_close()
        stop.set(); sampler.join()
        for log in logs:
            log.close()
        result['sampledCombinedPeakBytes'] = peaks.pop('combinedCgroup', 0)
        result['peakRssBytes'] = peaks
        result['cgroupPeakBytes'] = int((cgroup / 'memory.peak').read_text())
        result['cgroupEvents'] = (cgroup / 'memory.events').read_text()
        (args.output / 'result.json').write_text(json.dumps(result, indent=2) + '\n')
        print(json.dumps(result), flush=True)
    return 0 if result['passed'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
