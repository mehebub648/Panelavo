export type VpnCheckStatus = "pass" | "warning" | "blocked";

export interface VpnDiagnostic {
  id: string;
  label: string;
  status: VpnCheckStatus;
  detail: string;
  resolution?: string;
}

export interface VpnPreflight {
  supported: boolean;
  os: string;
  kernel: string;
  wireguardInstalled: boolean;
  wireguardVersion?: string | null;
  kernelModuleReady: boolean;
  nftablesInstalled: boolean;
  firewallMode: "ufw" | "nftables" | "unsupported";
  publicIpv4?: string | null;
  publicIpv6?: string | null;
  egressInterface?: string | null;
  ipv6Egress: boolean;
  defaults: {
    endpoint: string;
    listenPort: number;
    ipv4Cidr: string;
    dns: string[];
  };
  diagnostics: VpnDiagnostic[];
}

export interface VpnDevice {
  id: string;
  name: string;
  publicKey: string;
  ipv4: string;
  ipv6: string;
  createdAt: string;
  lastHandshakeAt?: string | null;
  receivedBytes: number;
  sentBytes: number;
  connected: boolean;
}

export interface VpnConfiguration {
  interface: "pnlwg0";
  endpoint: string;
  listenPort: number;
  ipv4Cidr: string;
  ipv6Cidr: string;
  dns: string[];
  egressInterface: string;
  ipv6Egress: boolean;
  firewallMode: "ufw" | "nftables";
}

export interface VpnState {
  generatedAt: string;
  installed: boolean;
  running: boolean;
  enabled: boolean;
  configuration?: VpnConfiguration;
  devices: VpnDevice[];
  diagnostics: VpnDiagnostic[];
  preflight: VpnPreflight;
  providerFirewallInstruction: string;
}

export interface VpnProvisioningResult {
  device: VpnDevice;
  configuration: string;
  qrCode?: string;
}

export type VpnManageInput =
  | {
      action: "install";
      endpoint: string;
      listenPort: number;
      ipv4Cidr: string;
      dns: string[];
      confirmation: "INSTALL VPN";
    }
  | { action: "start" }
  | {
      action: "stop";
      confirmation: "STOP VPN";
    }
  | {
      action: "restart";
      confirmation: "RESTART VPN";
    }
  | {
      action: "uninstall";
      confirmation: "UNINSTALL VPN";
    }
  | { action: "create-device"; name: string }
  | { action: "rename-device"; deviceId: string; name: string }
  | {
      action: "rotate-device";
      deviceId: string;
      confirmation: "ROTATE DEVICE";
    }
  | {
      action: "revoke-device";
      deviceId: string;
      confirmation: "REVOKE DEVICE";
    };

export interface VpnManageResult {
  state: VpnState;
  provisioning?: VpnProvisioningResult;
}
