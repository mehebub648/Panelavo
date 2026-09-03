// @vitest-environment jsdom

import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { VpnState } from "@/types/vpn";
import { VpnManager } from "./vpn-manager";

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

afterEach(() => cleanup());

function state(installed: boolean): VpnState {
  const diagnostic = {
    id: "os",
    label: "Supported operating system",
    status: "pass" as const,
    detail: "Ubuntu 24.04 LTS",
  };
  return {
    generatedAt: "2026-09-04T00:00:00Z",
    installed,
    running: installed,
    enabled: installed,
    devices: installed
      ? [
          {
            id: "0123456789abcdef",
            name: "Work phone",
            publicKey: "public",
            ipv4: "10.66.66.2",
            ipv6: "fd12:3456:789a:1::2",
            createdAt: "2026-09-04T00:00:00Z",
            receivedBytes: 1024,
            sentBytes: 2048,
            connected: true,
            lastHandshakeAt: "2026-09-04T00:00:00Z",
          },
        ]
      : [],
    diagnostics: [diagnostic],
    preflight: {
      supported: true,
      os: "Ubuntu 24.04 LTS",
      kernel: "6.8.0",
      wireguardInstalled: installed,
      kernelModuleReady: true,
      nftablesInstalled: installed,
      firewallMode: "nftables",
      ipv6Egress: false,
      defaults: {
        endpoint: "203.0.113.10",
        listenPort: 51820,
        ipv4Cidr: "10.66.66.0/24",
        dns: ["1.1.1.1", "1.0.0.1"],
      },
      diagnostics: [diagnostic],
    },
    configuration: installed
      ? {
          interface: "pnlwg0",
          endpoint: "203.0.113.10",
          listenPort: 51820,
          ipv4Cidr: "10.66.66.0/24",
          ipv6Cidr: "fd12:3456:789a:1::/64",
          dns: ["1.1.1.1"],
          egressInterface: "eth0",
          ipv6Egress: false,
          firewallMode: "nftables",
        }
      : undefined,
    providerFirewallInstruction: "Allow inbound UDP 51820.",
  };
}

describe("VpnManager", () => {
  it("shows the bounded installation form and preflight", () => {
    render(<VpnManager initialState={state(false)} />);
    expect(screen.getByText("Install VPN gateway")).toBeInTheDocument();
    expect(screen.getByDisplayValue("10.66.66.0/24")).toBeInTheDocument();
    expect(screen.getByText("Installation preflight")).toBeInTheDocument();
  });

  it("shows live devices and the fail-closed IPv6 state", () => {
    render(<VpnManager initialState={state(true)} />);
    expect(screen.getByText("Work phone")).toBeInTheDocument();
    expect(screen.getByText("Fail closed")).toBeInTheDocument();
    expect(screen.getByText("Remove VPN gateway")).toBeInTheDocument();
  });

  it("requires the exact destructive confirmation phrase", () => {
    render(<VpnManager initialState={state(true)} />);
    fireEvent.click(screen.getByRole("button", { name: "Uninstall" }));
    const submit = screen.getByRole("button", { name: "Uninstall VPN" });
    expect(submit).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/Type UNINSTALL VPN to continue/), {
      target: { value: "UNINSTALL VPN" },
    });
    expect(submit).toBeEnabled();
  });
});
