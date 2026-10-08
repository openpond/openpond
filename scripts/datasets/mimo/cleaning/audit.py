"""Check the rebuilt image for the demonstrated Git/timestamp leak vectors."""
import json
import shlex


def audit(docker, task, receipt, root):
    cwd = task["instance"]["cwd"]
    script = '''import json, os, subprocess, sys
cwd = sys.argv[1]
def git(*args):
    return subprocess.check_output(['git', '-c', 'safe.directory=' + cwd,
        '-c', 'core.hooksPath=/dev/null', '-C', cwd, *args])
timestamp_errors, other_git, count = [], [], 0
for directory, directories, files in os.walk('/'):
    directories[:] = [d for d in directories if os.path.join(directory, d) not in ('/proc', '/sys', '/dev')]
    for entry in directories + files:
        path = os.path.join(directory, entry)
        # Docker creates mount entries and updates /etc after image creation.
        if path in ('/etc', '/etc/mtab', '/etc/hosts', '/etc/hostname', '/etc/resolv.conf', '/.dockerenv'):
            continue
        count += 1
        if entry == '.git' and path != cwd + '/.git': other_git.append(path)
        if int(os.lstat(path).st_mtime) != 946684800: timestamp_errors.append(path)
print(json.dumps({'baseline': git('rev-parse', 'HEAD').decode().strip(),
    'reachableCommits': int(git('rev-list', '--all', '--count')),
    'unreachableOutputEmpty': not git('fsck', '--full', '--no-reflogs', '--unreachable').strip(),
    'worktreeClean': not git('status', '--porcelain').strip(),
    'timestampErrors': timestamp_errors, 'otherGitDirectories': other_git,
    'checkedPaths': count}))'''
    result = json.loads(docker.guest(receipt["cleanImageId"],
                        "python3 -c " + shlex.quote(script) + " " + shlex.quote(cwd), timeout=300).stdout)
    result["passed"] = (result["baseline"] == receipt["cleanBaselineCommit"] and
        result["reachableCommits"] == 1 and result["unreachableOutputEmpty"] and result["worktreeClean"] and
        not result["timestampErrors"] and not result["otherGitDirectories"])
    result["scope"] = "Demonstrated Git and timestamp vectors; independent residual artifact review remains required"
    (root / "cleanup/code" / task["id"] / "known-leak-vector-audit.json").write_text(json.dumps(result, indent=2))
    if not result["passed"]:
        raise ValueError("Rebuilt environment failed history/timestamp audit")
    return result
