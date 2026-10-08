import { useEffect, useState } from "react";
import type {
  RemoteDevice,
  RemoteAccessSettingsAction,
} from "@openpond/contracts";

export function RemoteAccessDeviceRow({
  device,
  self,
  busy,
  webBaseUrl,
  teamId,
  act,
}: {
  device: RemoteDevice;
  self: boolean;
  busy: boolean;
  webBaseUrl: string | null;
  teamId: string | null;
  act(
    action: RemoteAccessSettingsAction,
    body?: Record<string, unknown>,
  ): Promise<void>;
}) {
  const [name, setName] = useState(device.name);
  useEffect(() => setName(device.name), [device.name]);
  const scopeQuery = teamId === null
    ? "remoteScope=personal"
    : `remoteTeam=${encodeURIComponent(teamId)}`;
  const tasksUrl = webBaseUrl
    ? `${webBaseUrl}/?remoteDevice=${encodeURIComponent(device.id)}&${scopeQuery}`
    : null;
  return (
    <div className="account-summary">
      <div>
        <strong>
          {device.name}
          {self ? " · This computer" : ""}
        </strong>
        <small>
          {device.status.replaceAll("_", " ")} · {device.taskCount} tasks at
          last sync
        </small>
        <small>
          Last seen{" "}
          {device.lastSeenAt
            ? new Date(device.lastSeenAt).toLocaleString()
            : "never"}{" "}
          · Catalog synced{" "}
          {device.lastCatalogSyncAt
            ? new Date(device.lastCatalogSyncAt).toLocaleString()
            : "never"}
        </small>
        <label>
          Computer name{" "}
          <input
            value={name}
            maxLength={200}
            disabled={busy}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
      </div>
      <div className="account-summary-actions">
        {tasksUrl && (
          <a href={tasksUrl} target="_blank" rel="noreferrer">
            Open tasks
          </a>
        )}
        <button
          type="button"
          disabled={busy || !name.trim() || name.trim() === device.name}
          onClick={() =>
            void act("rename", {
              deviceId: device.id,
              revision: device.revision,
              name: name.trim(),
            })
          }
        >
          Save name
        </button>
        <button
          type="button"
          disabled={busy || !device.enabled}
          onClick={() =>
            void act(
              self ? "disable" : "disable-device",
              self ? {} : { deviceId: device.id, revision: device.revision },
            )
          }
        >
          Turn off
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() =>
            void act("remove", {
              deviceId: device.id,
              revision: device.revision,
            })
          }
        >
          Remove
        </button>
      </div>
    </div>
  );
}
