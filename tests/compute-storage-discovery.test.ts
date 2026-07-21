import { describe, expect, test } from "vitest";
import {
  labelForGvfsMount,
  parseLinuxMountInfo,
  parseMacMountOutput,
  parseWindowsLogicalDisks,
} from "../apps/server/src/compute/storage-discovery";

describe("compute storage discovery", () => {
  test("keeps real Linux drives and network mounts while filtering virtual filesystems", () => {
    const candidates = parseLinuxMountInfo([
      "29 1 253:0 / / rw,relatime - ext4 /dev/mapper/data-root rw",
      "35 29 0:31 / /proc rw,nosuid - proc proc rw",
      "48 29 8:17 / /media/glu/My\\040Passport rw,nosuid - exfat /dev/sdb1 rw",
      "51 29 0:44 / /mnt/team\\040models rw,relatime - cifs //nas/models rw",
      "57 29 0:49 / /run/user/1000/gvfs rw,nosuid - fuse.gvfsd-fuse gvfsd-fuse rw",
      "60 29 0:52 / /var/lib/docker/overlay2/example rw - overlay overlay rw",
    ].join("\n"), "/home/glu/.openpond/openpond-app");

    expect(candidates).toEqual([
      { kind: "local", label: "System disk", path: "/", modelStorePath: "/home/glu/.openpond/openpond-app/models", datasetStorePath: "/home/glu/.openpond/openpond-app/datasets" },
      { kind: "removable", label: "My Passport", path: "/media/glu/My Passport", modelStorePath: "/media/glu/My Passport", datasetStorePath: "/media/glu/My Passport/OpenPond/datasets" },
      { kind: "network", label: "models", path: "/mnt/team models", modelStorePath: "/mnt/team models", datasetStorePath: "/mnt/team models/OpenPond/datasets" },
    ]);
  });

  test("turns GVFS SMB mount names into human-readable share labels", () => {
    expect(labelForGvfsMount("smb-share:domain=WORKGROUP,server=192.168.1.234,share=openpondmodels,user=glu")).toBe("openpondmodels on 192.168.1.234");
    expect(labelForGvfsMount("sftp:host=example.test,user=glu")).toBe("example.test");
  });

  test("parses macOS volumes and Windows logical disks", () => {
    expect(parseMacMountOutput([
      "/dev/disk3s1s1 on / (apfs, sealed, local, read-only)",
      "/dev/disk4s1 on /Volumes/Fast\\040Disk (apfs, local, nodev)",
      "//glu@nas/models on /Volumes/Models (smbfs, nodev, nosuid)",
    ].join("\n"), "/Users/glu/Library/Application Support/OpenPond")).toEqual([
      { kind: "local", label: "System disk", path: "/", modelStorePath: "/Users/glu/Library/Application Support/OpenPond/models", datasetStorePath: "/Users/glu/Library/Application Support/OpenPond/datasets" },
      { kind: "removable", label: "Fast Disk", path: "/Volumes/Fast Disk", modelStorePath: "/Volumes/Fast Disk", datasetStorePath: "/Volumes/Fast Disk/OpenPond/datasets" },
      { kind: "network", label: "models", path: "/Volumes/Models", modelStorePath: "/Volumes/Models", datasetStorePath: "/Volumes/Models/OpenPond/datasets" },
    ]);

    expect(parseWindowsLogicalDisks(JSON.stringify([
      { DeviceID: "C:", VolumeName: "Windows", DriveType: 3 },
      { DeviceID: "E:", VolumeName: "Model SSD", DriveType: 2 },
      { DeviceID: "Z:", VolumeName: "Team models", DriveType: 4 },
    ]), "C:\\Users\\glu\\AppData\\Roaming\\OpenPond")).toEqual([
      { kind: "local", label: "Windows", path: "C:\\", modelStorePath: "C:\\Users\\glu\\AppData\\Roaming\\OpenPond\\models", datasetStorePath: "C:\\Users\\glu\\AppData\\Roaming\\OpenPond\\datasets" },
      { kind: "removable", label: "Model SSD", path: "E:\\", modelStorePath: "E:\\", datasetStorePath: "E:\\OpenPond\\datasets" },
      { kind: "network", label: "Team models", path: "Z:\\", modelStorePath: "Z:\\", datasetStorePath: "Z:\\OpenPond\\datasets" },
    ]);
  });
});
