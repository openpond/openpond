import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  parseTailscaleServeConfig,
  parseTailscaleStatusJson,
} from "../apps/server/dist/remote-access/tailscale.js";

describe("remote access", () => {
  test("normalizes tailscale status peers and self device", () => {
    const state = parseTailscaleStatusJson(
      {
        BackendState: "Running",
        AuthURL: "",
        TailscaleIPs: ["100.64.0.10"],
        MagicDNSSuffix: "tailnet.ts.net",
        CurrentTailnet: {
          Name: "example.com",
        },
        Self: {
          ID: "self",
          HostName: "workstation",
          DNSName: "workstation.tailnet.ts.net.",
          OS: "linux",
          Online: true,
          Active: true,
          TailscaleIPs: ["100.64.0.10"],
        },
        Peer: {
          "nodekey:phone": {
            ID: "phone",
            HostName: "phone",
            DNSName: "phone.tailnet.ts.net.",
            OS: "ios",
            Online: true,
            Active: false,
            TailscaleIPs: ["100.64.0.11"],
            LastSeen: "2026-05-27T14:00:00Z",
          },
        },
      },
      "1.98.3",
    );

    assert.equal(state.installed, true);
    assert.equal(state.running, true);
    assert.equal(state.authUrl, null);
    assert.equal(state.dnsName, "workstation.tailnet.ts.net");
    assert.equal(state.peers[0].isSelf, true);
    assert.equal(state.peers[1].name, "phone");
  });

  test("detects OpenPond Tailscale Serve target", () => {
    const serve = parseTailscaleServeConfig(
      {
        TCP: {
          "443": { HTTPS: true },
        },
        Web: {
          "workstation.tailnet.ts.net:443": {
            Handlers: {
              "/": {
                Proxy: "http://127.0.0.1:17874",
              },
            },
          },
        },
      },
      17874,
      "https://workstation.tailnet.ts.net",
      true,
    );

    assert.equal(serve.enabled, true);
    assert.equal(serve.reachable, true);
    assert.equal(serve.httpsUrl, "https://workstation.tailnet.ts.net");
    assert.equal(serve.targetUrl, "http://127.0.0.1:17874");
  });
});
