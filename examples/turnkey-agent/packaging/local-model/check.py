"""Prove packaged inference, auth, cancellation and RAM accounting with no egress.

Failure story: a model copied twice, a failed cancellation leaking the single
slot, or an unauthenticated request reaching inference must block publication.
"""
import argparse
import hashlib
import json
import pathlib
import subprocess
import shlex
import time

TOKEN = 'local-inference-smoke'  # Deliberately synthetic; never a deployment credential.


def run(*args, check=True):
    return subprocess.run(args, check=check, text=True, capture_output=True, timeout=360)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--image', required=True, help='Image built with Containerfile.check')
    parser.add_argument('--output', required=True, type=pathlib.Path)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    config = json.dumps({'mode': 'embedded', 'port': 3000, 'authTokenSha256': hashlib.sha256(TOKEN.encode()).hexdigest()})
    container = run('docker', 'run', '-d', '--memory=1g', '--memory-swap=1g', '--cpus=2', '--network=none',
                    '--read-only', '--tmpfs', '/ram:rw,exec,size=700m', '--tmpfs', '/tmp:rw,noexec,size=96m', args.image, config).stdout.strip()
    report = {'image': args.image, 'memoryMaxBytes': 1073741824, 'swapMaxBytes': 0, 'network': 'none', 'turns': []}

    def command(prompt, token=TOKEN, timeout=310):
        return ['docker', 'exec', container, 'wget', '-T', str(timeout), '-qO-',
                '--header=Authorization: Bearer ' + token, '--header=Content-Type: application/json',
                '--post-data=' + json.dumps({'prompt': prompt}), 'http://127.0.0.1:3000/chat']

    def memory():
        result = {}
        for name in ['memory.current', 'memory.peak', 'memory.events']:
            result[name] = run('docker', 'exec', container, 'cat', '/sys/fs/cgroup/' + name).stdout.strip()
        return result

    def clean():
        listing = run('docker', 'exec', container, 'find', '/ram', '-type', 'd', '-name', 'openpond-tvc-request-*').stdout
        return 'openpond-tvc-request-' not in listing

    try:
        deadline = time.monotonic() + 120
        while time.monotonic() < deadline:
            health = run('docker', 'exec', container, 'wget', '-T', '2', '-qO-', 'http://127.0.0.1:3000/health', check=False)
            if health.returncode == 0:
                report['health'] = json.loads(health.stdout)
                break
            time.sleep(0.5)
        else:
            raise RuntimeError('Packaged model did not become ready')
        assert report['health']['inference'] == 'embedded'
        rejected = run(*command('This must not start inference.', token='wrong'), check=False)
        assert '401' in rejected.stderr, rejected.stderr
        rejected = run(*command('x' * 1025), check=False)
        assert '400' in rejected.stderr, rejected.stderr
        for prompt, expected in [('What is 7 plus 5? Answer briefly.', '12'), ('What is the capital of France?', 'Paris')]:
            started = time.monotonic()
            response = json.loads(run(*command(prompt)).stdout)
            assert expected.lower() in response['answer'].lower(), response
            assert response['tools'] == []
            report['turns'].append({'prompt': prompt, 'response': response, 'seconds': round(time.monotonic() - started, 2), 'memory': memory()})
        # The long request is interrupted by its client; another caller cannot
        # occupy the single slot while the first request is still active.
        cancel_command = 'echo $$ > /tmp/tvc-cancel-client.pid; exec ' + ' '.join(shlex.quote(part) for part in command('List every number from 1 to 200, one per line.')[3:])
        cancelled = subprocess.Popen(['docker', 'exec', container, 'sh', '-c', cancel_command], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            time.sleep(0.25)
            busy = run(*command('Second caller'), check=False)
            assert '503' in busy.stderr, busy.stderr
            client_pid = run('docker', 'exec', container, 'cat', '/tmp/tvc-cancel-client.pid').stdout.strip()
            run('docker', 'exec', container, 'kill', '-TERM', client_pid)
            cancelled.communicate(timeout=10)
            assert cancelled.returncode != 0, 'The request completed before cancellation was exercised'
        finally:
            if cancelled.poll() is None:
                cancelled.kill()
                cancelled.communicate()
        deadline = time.monotonic() + 15
        while not clean() and time.monotonic() < deadline:
            time.sleep(0.2)
        assert clean(), 'Cancellation leaked request state'
        response = json.loads(run(*command('What is 7 plus 5? Answer briefly.')).stdout)
        assert '12' in response['answer'], response
        report['cancellationRecovery'] = response
        assert clean(), 'Completed turn leaked request state'
        report['finalMemory'] = memory()
        events = dict(line.split() for line in report['finalMemory']['memory.events'].splitlines())
        assert events['oom'] == '0' and events['oom_kill'] == '0', events
        report['passed'] = True
    finally:
        report['containerState'] = json.loads(run('docker', 'inspect', '--format', '{{json .State}}', container).stdout)
        (args.output / 'app.log').write_text(run('docker', 'logs', container, check=False).stdout)
        (args.output / 'result.json').write_text(json.dumps(report, indent=2) + '\n')
        run('docker', 'stop', '-t', '15', container, check=False)
        run('docker', 'rm', '-f', container, check=False)
    print(json.dumps(report, indent=2))


if __name__ == '__main__':
    main()
