"use client";

import Image from "next/image";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  CircleStop,
  Copy,
  Download,
  ExternalLink,
  KeyRound,
  LoaderCircle,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  RotateCw,
  Shield,
  ShieldCheck,
  Smartphone,
  Trash2,
  Wifi,
  XCircle,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type {
  VpnManageInput,
  VpnManageResult,
  VpnProvisioningResult,
  VpnState,
} from "@/types/vpn";

type PendingAction = {
  input: VpnManageInput;
  title: string;
  message: string;
  confirmText: string;
  confirmationPhrase: string;
  danger?: boolean;
};

function bytes(value: number) {
  if (!value) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(
    Math.floor(Math.log(value) / Math.log(1024)),
    units.length - 1,
  );
  return `${(value / 1024 ** index).toFixed(index ? 1 : 0)} ${units[index]}`;
}

function date(value?: string | null) {
  return value ? new Date(value).toLocaleString() : "Never";
}

const checkStyles = {
  pass: {
    icon: CheckCircle2,
    className: "bg-emerald-50 text-emerald-700",
  },
  warning: {
    icon: AlertTriangle,
    className: "bg-amber-50 text-amber-700",
  },
  blocked: { icon: XCircle, className: "bg-red-50 text-red-700" },
} as const;

export function VpnManager({
  initialState,
  apiBase = "",
}: {
  initialState: VpnState;
  apiBase?: string;
}) {
  const [state, setState] = useState(initialState);
  const [busy, setBusy] = useState<string>();
  const [pending, setPending] = useState<PendingAction>();
  const [provisioning, setProvisioning] = useState<VpnProvisioningResult>();
  const [deviceName, setDeviceName] = useState("");
  const [renaming, setRenaming] = useState<string>();
  const [renameValue, setRenameValue] = useState("");
  const defaults = initialState.preflight.defaults;
  const [endpoint, setEndpoint] = useState(defaults.endpoint);
  const [listenPort, setListenPort] = useState(String(defaults.listenPort));
  const [ipv4Cidr, setIpv4Cidr] = useState(defaults.ipv4Cidr);
  const [dns, setDns] = useState(defaults.dns.join(", "));

  const hardBlocked = state.preflight.diagnostics.some(
    (item) =>
      item.status === "blocked" &&
      ["os", "kernel", "firewall", "egress", "ownership"].includes(item.id),
  );
  const onlineDevices = state.devices.filter(
    (device) => device.connected,
  ).length;
  const totalTraffic = useMemo(
    () =>
      state.devices.reduce(
        (total, device) => total + device.receivedBytes + device.sentBytes,
        0,
      ),
    [state.devices],
  );

  const refresh = useCallback(async (silent = false) => {
    try {
      const response = await fetch(`${apiBase}/api/vpn`, { cache: "no-store" });
      const body = await response.json();
      if (!body.success)
        throw new Error(body.error?.message || "Could not refresh VPN status.");
      setState(body.data as VpnState);
    } catch (error) {
      if (!silent)
        toast.error(
          error instanceof Error
            ? error.message
            : "Could not refresh VPN status.",
        );
    }
  }, [apiBase]);

  async function execute(input: VpnManageInput) {
    setBusy(input.action);
    try {
      const response = await fetch(`${apiBase}/api/vpn`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      });
      const body = await response.json();
      if (!body.success)
        throw new Error(body.error?.message || "The VPN operation failed.");
      const result = body.data as VpnManageResult;
      setState(result.state);
      if (result.provisioning) setProvisioning(result.provisioning);
      if (input.action === "create-device") setDeviceName("");
      setRenaming(undefined);
      toast.success(
        input.action === "install"
          ? "WireGuard VPN installed."
          : input.action === "uninstall"
            ? "Panelavo WireGuard removed."
            : input.action === "create-device" ||
                input.action === "rotate-device"
              ? "One-time device configuration created."
              : "VPN updated.",
      );
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "The VPN operation failed.",
      );
    } finally {
      setBusy(undefined);
      setPending(undefined);
    }
  }

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh(true);
    }, 30_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  function requestInstall() {
    const port = Number(listenPort);
    const addresses = dns
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    setPending({
      input: {
        action: "install",
        endpoint: endpoint.trim(),
        listenPort: port,
        ipv4Cidr: ipv4Cidr.trim(),
        dns: addresses,
        confirmation: "INSTALL VPN",
      },
      title: "Install WireGuard on this server?",
      message:
        "Panelavo will install distribution packages when needed, add only namespaced networking rules, and start pnlwg0. Hosted websites and private application ports stay outside the VPN.",
      confirmText: "Install VPN",
      confirmationPhrase: "INSTALL VPN",
    });
  }

  function downloadConfiguration() {
    if (!provisioning) return;
    const blob = new Blob([provisioning.configuration], {
      type: "text/plain;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${provisioning.device.name.replace(/[^A-Za-z0-9._-]+/g, "-") || "panelavo-vpn"}.conf`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="w-full space-y-6">
      <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-end">
        <div>
          <h2 className="text-2xl font-bold tracking-tight text-ink">
            WireGuard VPN
          </h2>
          <p className="mt-1 max-w-3xl text-sm text-slate-500">
            Run a lightweight full-tunnel gateway directly in the Linux kernel.
            VPN devices are isolated from private server services, hosted app
            ports, and one another.
          </p>
        </div>
        <Button
          variant="outline"
          disabled={Boolean(busy)}
          onClick={() => void refresh()}
        >
          <RefreshCw className={cn("h-4 w-4", busy && "animate-spin")} />
          Refresh
        </Button>
      </div>

      {!state.installed ? (
        <div className="grid gap-5 xl:grid-cols-[minmax(0,1.1fr)_minmax(360px,.9fr)]">
          <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-card sm:p-6">
            <div className="flex items-start gap-3">
              <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-panel-50 text-panel-700">
                <Shield className="h-5 w-5" />
              </span>
              <div>
                <h3 className="font-bold text-ink">Install VPN gateway</h3>
                <p className="mt-1 text-sm text-slate-500">
                  Settings are fixed after installation because device private
                  configurations are never retained by Panelavo.
                </p>
              </div>
            </div>
            <div className="mt-6 grid gap-4 sm:grid-cols-2">
              <label className="sm:col-span-2">
                <span className="mb-1.5 block text-sm font-medium text-slate-700">
                  Direct public endpoint
                </span>
                <Input
                  value={endpoint}
                  onChange={(event) => setEndpoint(event.target.value)}
                  placeholder="203.0.113.10 or vpn.example.com"
                />
                <span className="mt-1.5 block text-xs text-slate-400">
                  Hostnames must resolve directly to this server; proxied DNS is
                  not supported for WireGuard UDP.
                </span>
              </label>
              <label>
                <span className="mb-1.5 block text-sm font-medium text-slate-700">
                  UDP port
                </span>
                <Input
                  inputMode="numeric"
                  value={listenPort}
                  onChange={(event) => setListenPort(event.target.value)}
                />
              </label>
              <label>
                <span className="mb-1.5 block text-sm font-medium text-slate-700">
                  Private IPv4 /24
                </span>
                <Input
                  value={ipv4Cidr}
                  onChange={(event) => setIpv4Cidr(event.target.value)}
                />
              </label>
              <label className="sm:col-span-2">
                <span className="mb-1.5 block text-sm font-medium text-slate-700">
                  DNS addresses
                </span>
                <Input
                  value={dns}
                  onChange={(event) => setDns(event.target.value)}
                  placeholder="1.1.1.1, 1.0.0.1"
                />
                <span className="mt-1.5 block text-xs text-slate-400">
                  Comma-separated public resolver addresses, including at least
                  one IPv4 address. DNS travels through the tunnel.
                </span>
              </label>
            </div>
            <div className="mt-6 flex flex-wrap items-center gap-3">
              <Button
                disabled={
                  Boolean(busy) ||
                  hardBlocked ||
                  !endpoint.trim() ||
                  !listenPort.trim() ||
                  !ipv4Cidr.trim() ||
                  !dns.trim()
                }
                onClick={requestInstall}
              >
                {busy === "install" ? (
                  <LoaderCircle className="h-4 w-4 animate-spin" />
                ) : (
                  <ShieldCheck className="h-4 w-4" />
                )}
                Install WireGuard
              </Button>
              <span className="text-xs text-slate-400">
                No container or always-running dashboard service
              </span>
            </div>
            <div className="mt-4 rounded-xl bg-amber-50 p-4 text-sm text-amber-900">
              <strong>Provider firewall after installation:</strong> allow
              inbound UDP {listenPort || "51820"} to {endpoint || "this server"}
              . Do not expose Panelavo&apos;s TCP 10443 listener.
            </div>
          </section>

          <Diagnostics
            title="Installation preflight"
            items={state.preflight.diagnostics}
          />
        </div>
      ) : (
        <>
          <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <StatusCard
              icon={Wifi}
              label="Gateway"
              value={state.running ? "Running" : "Stopped"}
              note={state.enabled ? "Starts after reboot" : "Disabled at boot"}
              positive={state.running}
            />
            <StatusCard
              icon={Smartphone}
              label="Devices"
              value={`${onlineDevices} online`}
              note={`${state.devices.length} configured`}
            />
            <StatusCard
              icon={Activity}
              label="Traffic"
              value={bytes(totalTraffic)}
              note="Since current interface start"
            />
            <StatusCard
              icon={ShieldCheck}
              label="IPv6"
              value={
                state.configuration?.ipv6Egress ? "Tunneled" : "Fail closed"
              }
              note={
                state.configuration?.ipv6Egress
                  ? "Verified NAT66 egress"
                  : "No local-network leak"
              }
            />
          </section>

          <div className="grid gap-5 xl:grid-cols-[minmax(0,1.15fr)_minmax(340px,.85fr)]">
            <section className="rounded-2xl border border-slate-200 bg-white shadow-card">
              <div className="flex flex-col justify-between gap-3 border-b border-slate-100 px-5 py-4 sm:flex-row sm:items-center sm:px-6">
                <div>
                  <h3 className="font-bold text-ink">Gateway controls</h3>
                  <p className="mt-0.5 text-sm text-slate-500">
                    Interface {state.configuration?.interface} on UDP{" "}
                    {state.configuration?.listenPort}
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  {!state.running ? (
                    <Button
                      size="sm"
                      disabled={Boolean(busy)}
                      onClick={() => void execute({ action: "start" })}
                    >
                      <Play className="h-4 w-4" /> Start
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={Boolean(busy)}
                      onClick={() =>
                        setPending({
                          input: {
                            action: "stop",
                            confirmation: "STOP VPN",
                          },
                          title: "Stop the VPN gateway?",
                          message:
                            "Connected devices will immediately lose VPN connectivity. Hosted websites remain running.",
                          confirmText: "Stop VPN",
                          confirmationPhrase: "STOP VPN",
                        })
                      }
                    >
                      <CircleStop className="h-4 w-4" /> Stop
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={Boolean(busy) || !state.running}
                    onClick={() =>
                      setPending({
                        input: {
                          action: "restart",
                          confirmation: "RESTART VPN",
                        },
                        title: "Restart the VPN gateway?",
                        message:
                          "WireGuard reconnects quickly, but active device tunnels will be interrupted briefly.",
                        confirmText: "Restart",
                        confirmationPhrase: "RESTART VPN",
                      })
                    }
                  >
                    <RotateCw className="h-4 w-4" /> Restart
                  </Button>
                </div>
              </div>
              <dl className="grid gap-px bg-slate-100 sm:grid-cols-2">
                {[
                  [
                    "Endpoint",
                    `${state.configuration?.endpoint}:${state.configuration?.listenPort}`,
                  ],
                  ["IPv4 network", state.configuration?.ipv4Cidr],
                  ["IPv6 network", state.configuration?.ipv6Cidr],
                  ["Egress", state.configuration?.egressInterface],
                  ["Firewall", state.configuration?.firewallMode.toUpperCase()],
                  ["DNS", state.configuration?.dns.join(", ")],
                ].map(([label, value]) => (
                  <div key={label} className="bg-white px-5 py-4 sm:px-6">
                    <dt className="text-xs font-semibold uppercase tracking-wide text-slate-400">
                      {label}
                    </dt>
                    <dd className="mt-1 break-all text-sm font-semibold text-slate-700">
                      {value}
                    </dd>
                  </div>
                ))}
              </dl>
              <div className="border-t border-slate-100 px-5 py-4 sm:px-6">
                <div className="rounded-xl bg-amber-50 p-4 text-sm text-amber-900">
                  <strong>Provider firewall:</strong>{" "}
                  {state.providerFirewallInstruction}
                </div>
              </div>
            </section>

            <Diagnostics title="Gateway health" items={state.diagnostics} />
          </div>

          <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-card">
            <div className="flex flex-col justify-between gap-4 border-b border-slate-100 px-5 py-4 sm:flex-row sm:items-end sm:px-6">
              <div>
                <h3 className="font-bold text-ink">VPN devices</h3>
                <p className="mt-0.5 text-sm text-slate-500">
                  Private configurations are shown once. Traffic figures reset
                  when the interface restarts.
                </p>
              </div>
              <div className="flex w-full gap-2 sm:w-auto">
                <Input
                  className="min-w-0 sm:w-64"
                  value={deviceName}
                  maxLength={64}
                  placeholder="Device name"
                  onChange={(event) => setDeviceName(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && deviceName.trim() && !busy)
                      void execute({
                        action: "create-device",
                        name: deviceName.trim(),
                      });
                  }}
                />
                <Button
                  disabled={Boolean(busy) || !deviceName.trim()}
                  onClick={() =>
                    void execute({
                      action: "create-device",
                      name: deviceName.trim(),
                    })
                  }
                >
                  <Plus className="h-4 w-4" /> Add
                </Button>
              </div>
            </div>
            {state.devices.length ? (
              <div className="divide-y divide-slate-100">
                {state.devices.map((device) => (
                  <div
                    key={device.id}
                    className="grid gap-4 px-5 py-5 sm:px-6 lg:grid-cols-[minmax(180px,1.2fr)_minmax(150px,.8fr)_minmax(170px,.8fr)_auto] lg:items-center"
                  >
                    <div className="min-w-0">
                      {renaming === device.id ? (
                        <div className="flex gap-2">
                          <Input
                            autoFocus
                            value={renameValue}
                            maxLength={64}
                            onChange={(event) =>
                              setRenameValue(event.target.value)
                            }
                          />
                          <Button
                            size="sm"
                            disabled={!renameValue.trim() || Boolean(busy)}
                            onClick={() =>
                              void execute({
                                action: "rename-device",
                                deviceId: device.id,
                                name: renameValue.trim(),
                              })
                            }
                          >
                            Save
                          </Button>
                        </div>
                      ) : (
                        <div className="flex items-center gap-3">
                          <span
                            className={cn(
                              "h-2.5 w-2.5 rounded-full",
                              device.connected
                                ? "bg-emerald-500"
                                : "bg-slate-300",
                            )}
                          />
                          <div className="min-w-0">
                            <p className="truncate font-semibold text-slate-800">
                              {device.name}
                            </p>
                            <p className="mt-0.5 font-mono text-xs text-slate-400">
                              {device.ipv4} · {device.ipv6}
                            </p>
                          </div>
                        </div>
                      )}
                    </div>
                    <div>
                      <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">
                        Last handshake
                      </p>
                      <p className="mt-1 text-sm font-medium text-slate-700">
                        {date(device.lastHandshakeAt)}
                      </p>
                    </div>
                    <div>
                      <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">
                        Current traffic
                      </p>
                      <p className="mt-1 text-sm font-medium text-slate-700">
                        ↓ {bytes(device.receivedBytes)} · ↑{" "}
                        {bytes(device.sentBytes)}
                      </p>
                    </div>
                    <div className="flex flex-wrap justify-start gap-1 lg:justify-end">
                      <Button
                        size="icon"
                        variant="ghost"
                        title="Rename device"
                        disabled={Boolean(busy)}
                        onClick={() => {
                          setRenaming(device.id);
                          setRenameValue(device.name);
                        }}
                      >
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        title="Rotate device configuration"
                        disabled={Boolean(busy)}
                        onClick={() =>
                          setPending({
                            input: {
                              action: "rotate-device",
                              deviceId: device.id,
                              confirmation: "ROTATE DEVICE",
                            },
                            title: `Rotate ${device.name}?`,
                            message:
                              "The current configuration stops working immediately. The replacement QR and file will be shown once.",
                            confirmText: "Rotate keys",
                            confirmationPhrase: "ROTATE DEVICE",
                            danger: true,
                          })
                        }
                      >
                        <KeyRound className="h-4 w-4" />
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="text-red-600 hover:bg-red-50 hover:text-red-700"
                        title="Revoke device"
                        disabled={Boolean(busy)}
                        onClick={() =>
                          setPending({
                            input: {
                              action: "revoke-device",
                              deviceId: device.id,
                              confirmation: "REVOKE DEVICE",
                            },
                            title: `Revoke ${device.name}?`,
                            message:
                              "This device loses VPN access immediately. The action cannot be undone.",
                            confirmText: "Revoke device",
                            confirmationPhrase: "REVOKE DEVICE",
                            danger: true,
                          })
                        }
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="px-6 py-12 text-center">
                <Smartphone className="mx-auto h-9 w-9 text-slate-300" />
                <p className="mt-3 text-sm font-semibold text-slate-600">
                  No devices yet
                </p>
                <p className="mt-1 text-sm text-slate-400">
                  Add a device to receive its one-time QR code and
                  configuration.
                </p>
              </div>
            )}
          </section>

          <section className="flex flex-col justify-between gap-4 rounded-2xl border border-red-100 bg-red-50/50 p-5 sm:flex-row sm:items-center sm:p-6">
            <div>
              <h3 className="font-bold text-red-900">Remove VPN gateway</h3>
              <p className="mt-1 max-w-3xl text-sm text-red-700">
                Removes only Panelavo-owned pnlwg0 configuration, keys, systemd,
                sysctl, nftables, and tagged UFW rules. Distribution packages
                and unrelated WireGuard interfaces remain installed.
              </p>
            </div>
            <Button
              variant="danger"
              disabled={Boolean(busy)}
              onClick={() =>
                setPending({
                  input: {
                    action: "uninstall",
                    confirmation: "UNINSTALL VPN",
                  },
                  title: "Uninstall Panelavo WireGuard?",
                  message:
                    "Every device configuration will be revoked and the gateway keys will be permanently deleted. Hosted websites will not be stopped.",
                  confirmText: "Uninstall VPN",
                  confirmationPhrase: "UNINSTALL VPN",
                  danger: true,
                })
              }
            >
              <Trash2 className="h-4 w-4" /> Uninstall
            </Button>
          </section>
        </>
      )}

      <SetupResources />

      {pending && (
        <ConfirmDialog
          title={pending.title}
          message={pending.message}
          confirmText={pending.confirmText}
          confirmationPhrase={pending.confirmationPhrase}
          variant={pending.danger ? "danger" : "default"}
          onCancel={() => setPending(undefined)}
          onConfirm={() => void execute(pending.input)}
        />
      )}

      {provisioning && (
        <div className="fixed inset-0 z-[110] overflow-y-auto bg-slate-950/50 p-4">
          <div className="mx-auto my-6 w-full max-w-3xl rounded-2xl bg-white p-5 shadow-2xl sm:p-7">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h3 className="text-xl font-bold text-ink">
                  Save {provisioning.device.name} now
                </h3>
                <p className="mt-1 text-sm text-amber-700">
                  This private configuration is shown once and cannot be
                  recovered. Rotate the device if it is lost.
                </p>
              </div>
              <Button
                variant="ghost"
                size="icon"
                aria-label="Close one-time configuration"
                onClick={() => setProvisioning(undefined)}
              >
                <XCircle className="h-5 w-5" />
              </Button>
            </div>
            <div className="mt-6 grid gap-5 md:grid-cols-[300px_minmax(0,1fr)]">
              <div className="rounded-2xl border border-slate-200 bg-white p-3 text-center">
                {provisioning.qrCode ? (
                  <Image
                    src={provisioning.qrCode}
                    alt={`WireGuard configuration QR code for ${provisioning.device.name}`}
                    width={280}
                    height={280}
                    unoptimized
                    className="mx-auto h-auto w-full max-w-[280px]"
                  />
                ) : null}
                <p className="mt-2 text-xs text-slate-500">
                  Scan with the official WireGuard mobile app.
                </p>
              </div>
              <div className="min-w-0">
                <pre className="max-h-72 overflow-auto rounded-xl bg-slate-950 p-4 text-xs leading-relaxed text-slate-100">
                  {provisioning.configuration}
                </pre>
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button onClick={downloadConfiguration}>
                    <Download className="h-4 w-4" /> Download .conf
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => {
                      void navigator.clipboard.writeText(
                        provisioning.configuration,
                      );
                      toast.success("Configuration copied.");
                    }}
                  >
                    <Copy className="h-4 w-4" /> Copy
                  </Button>
                </div>
              </div>
            </div>
            <div className="mt-6 flex justify-end">
              <Button onClick={() => setProvisioning(undefined)}>
                I saved the configuration
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function StatusCard({
  icon: Icon,
  label,
  value,
  note,
  positive,
}: {
  icon: typeof Wifi;
  label: string;
  value: string;
  note: string;
  positive?: boolean;
}) {
  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-card">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">
            {label}
          </p>
          <p className="mt-2 text-xl font-bold text-ink">{value}</p>
          <p className="mt-1 text-xs text-slate-500">{note}</p>
        </div>
        <span
          className={cn(
            "grid h-10 w-10 place-items-center rounded-xl",
            positive === false
              ? "bg-slate-100 text-slate-500"
              : "bg-panel-50 text-panel-700",
          )}
        >
          <Icon className="h-5 w-5" />
        </span>
      </div>
    </section>
  );
}

function Diagnostics({
  title,
  items,
}: {
  title: string;
  items: VpnState["diagnostics"];
}) {
  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-card sm:p-6">
      <h3 className="font-bold text-ink">{title}</h3>
      <div className="mt-4 space-y-3">
        {items.map((item) => {
          const style = checkStyles[item.status];
          const Icon = style.icon;
          return (
            <div key={item.id} className="flex items-start gap-3">
              <span
                className={cn(
                  "mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg",
                  style.className,
                )}
              >
                <Icon className="h-4 w-4" />
              </span>
              <div className="min-w-0">
                <p className="text-sm font-semibold text-slate-700">
                  {item.label}
                </p>
                <p className="mt-0.5 text-xs leading-relaxed text-slate-500">
                  {item.detail}
                </p>
                {item.status === "blocked" && item.resolution ? (
                  <p className="mt-1 text-xs font-medium text-red-600">
                    {item.resolution}
                  </p>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function SetupResources() {
  const links = [
    [
      "Windows",
      "https://download.wireguard.com/windows-client/wireguard-installer.exe",
    ],
    ["macOS", "https://apps.apple.com/us/app/wireguard/id1451685025"],
    [
      "Android",
      "https://play.google.com/store/apps/details?id=com.wireguard.android",
    ],
    ["iPhone & iPad", "https://apps.apple.com/us/app/wireguard/id1441195209"],
    ["Linux", "https://www.wireguard.com/install/"],
    ["Quick start", "https://www.wireguard.com/quickstart/"],
    [
      "Full-tunnel guide",
      "https://ubuntu.com/server/docs/how-to/wireguard-vpn/vpn-as-the-default-gateway/",
    ],
    [
      "Security tips",
      "https://ubuntu.com/server/docs/how-to/wireguard-vpn/security-tips/",
    ],
  ];
  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-card sm:p-6">
      <div className="flex items-start gap-3">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-blue-50 text-blue-700">
          <KeyRound className="h-5 w-5" />
        </span>
        <div>
          <h3 className="font-bold text-ink">Device setup and safety</h3>
          <p className="mt-1 text-sm text-slate-500">
            Install the official WireGuard client, then scan the one-time QR
            code on mobile or import the downloaded .conf file on desktop.
          </p>
        </div>
      </div>
      <div className="mt-5 flex flex-wrap gap-2">
        {links.map(([label, href]) => (
          <Button key={label} asChild variant="outline" size="sm">
            <a href={href} target="_blank" rel="noreferrer">
              {label} <ExternalLink className="h-3.5 w-3.5" />
            </a>
          </Button>
        ))}
      </div>
      <div className="mt-5 grid gap-3 text-sm md:grid-cols-3">
        <div className="rounded-xl bg-slate-50 p-4">
          <p className="font-semibold text-slate-700">Keep it private</p>
          <p className="mt-1 text-xs leading-relaxed text-slate-500">
            The QR code and configuration contain a private key. Never attach
            them to tickets, chats, or public diagnostics.
          </p>
        </div>
        <div className="rounded-xl bg-slate-50 p-4">
          <p className="font-semibold text-slate-700">First connection</p>
          <p className="mt-1 text-xs leading-relaxed text-slate-500">
            If no handshake appears, confirm inbound UDP at the hosting provider
            and verify the device clock and endpoint.
          </p>
        </div>
        <div className="rounded-xl bg-slate-50 p-4">
          <p className="font-semibold text-slate-700">Expected access</p>
          <p className="mt-1 text-xs leading-relaxed text-slate-500">
            Internet traffic and public web ports are allowed. SSH, databases,
            private app ports, and device-to-device traffic are blocked.
          </p>
        </div>
      </div>
    </section>
  );
}
