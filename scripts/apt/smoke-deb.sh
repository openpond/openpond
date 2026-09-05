#!/usr/bin/env bash
# Run only on disposable CI runners/containers: this installs system packages.
set -euo pipefail
[[ "${CI:-}" == "true" ]] || { echo 'Debian lifecycle smoke requires a disposable CI environment.' >&2; exit 1; }
package_path="$(realpath "${1:?Expected a .deb path}")"
package_name="$(dpkg-deb --field "${package_path}" Package)"
case "${package_name}" in
  openpond) executable=openpond-desktop ;;
  openpond-nightly) executable=openpond-desktop-nightly ;;
  *) echo "Unexpected package ${package_name}" >&2; exit 1 ;;
esac
as_root() {
  if [[ "$(id -u)" == 0 ]]; then "$@"; else sudo "$@"; fi
}
smoke_tmp="$(mktemp -d)"
chmod 755 "${smoke_tmp}"
trap 'rm -rf "${smoke_tmp}"' EXIT

# Exercise real maintainer scripts on install and upgrade. Reuse the candidate's
# payload with an older Debian version; no prior public .deb exists at bootstrap.
dpkg-deb --raw-extract "${package_path}" "${smoke_tmp}/previous"
python3 - "${smoke_tmp}/previous/DEBIAN/control" <<'PY'
from pathlib import Path
import re
import sys
control = Path(sys.argv[1])
control.write_text(re.sub(r'^Version:.*$', 'Version: 0~apt-smoke', control.read_text(), flags=re.MULTILINE))
PY
dpkg-deb --build --root-owner-group -Zgzip "${smoke_tmp}/previous" "${smoke_tmp}/previous.deb"
as_root env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends "${smoke_tmp}/previous.deb"
test -x "/usr/bin/${executable}"
as_root env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends "${package_path}"
test "$(dpkg-query -W -f='${Version}' "${package_name}")" = "$(dpkg-deb --field "${package_path}" Version)"
test -x "/usr/bin/${executable}"
# Verify that the installed runtime resolves its shared libraries on this distro.
ELECTRON_RUN_AS_NODE=1 "/usr/bin/${executable}" --version
python3 - "${package_name}" "${executable}" <<'PY'
from pathlib import Path
import subprocess
import sys
files = subprocess.check_output(['dpkg-query', '-L', sys.argv[1]], text=True).splitlines()
launchers = [Path(name) for name in files if name.endswith('.desktop')]
assert len(launchers) == 1, 'Expected one desktop launcher'
launcher = launchers[0].read_text()
assert sys.argv[2] in launcher, 'Desktop entry must launch the installed executable'
assert f'Icon={sys.argv[2]}\n' in launcher, 'Desktop entry must reference its installed icon'
assert any('/icons/' in name and Path(name).stem == sys.argv[2] for name in files), 'Missing desktop icon'
assert '/usr/bin/openpond' not in files, 'Desktop must not claim the CLI command'
PY
if [[ "${APT_SMOKE_DESKTOP:-}" == "1" ]]; then
  node --import tsx scripts/smoke-packaged-desktop.ts --app "/usr/bin/${executable}" --json "release-smoke/deb-${package_name}-$(dpkg --print-architecture).json"
fi
as_root apt-get remove -y "${package_name}"
test ! -e "/usr/bin/${executable}"
test ! -L "/usr/bin/${executable}"
as_root apt-get purge -y "${package_name}"
echo "Passed Debian install, upgrade and removal: ${package_name}"
