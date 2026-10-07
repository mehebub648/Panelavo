<?php
// Pure fixtures and a fake command runner: never touches the host firewall.
$source = file_get_contents(__DIR__ . '/cloudpanel-bridge.php');
$start = strpos($source, 'function vpnDockerLayout(');
$end = strpos($source, 'function vpnNftTableState(', $start);
eval(substr($source, $start, $end - $start));
const PANELAVO_VPN_MARKER = 'Managed by Panelavo WireGuard v1';
class VpnOperationException extends RuntimeException {
    public function __construct(public string $brokerCode, string $message) { parent::__construct($message); }
}
function check(bool $ok, string $message): void { if (!$ok) throw new RuntimeException($message); }
function vpnPrivate24(string $cidr): bool { return $cidr === '10.66.66.0/24'; }
function vpnExecutable(array $paths): ?string { return $paths[0]; }
$forward = "-P FORWARD DROP\n-A FORWARD -j DOCKER-USER\n-A FORWARD -j DOCKER-FORWARD";
$ruleset = ['nftables' => [['chain' => ['family' => 'ip', 'table' => 'filter', 'name' => 'FORWARD', 'hook' => 'forward', 'policy' => 'drop']]]];
$installed = []; $writes = []; $custom = ''; $failRead = false; $failInsert = false;
function vpnCommand(array $args, int $timeout = 8): array {
    global $forward, $ruleset, $installed, $writes, $custom, $failRead, $failInsert;
    $tool = basename($args[0]); $code = 0; $out = '';
    if ($tool === 'systemctl') $code = end($args) === 'docker.service' ? 0 : 3;
    elseif ($tool === 'ufw') $out = 'Status: inactive';
    elseif ($tool === 'nft') { $out = json_encode($ruleset); $code = $failRead ? 1 : 0; }
    elseif (in_array($tool, ['iptables', 'ip6tables'], true)) {
        if ($args[1] === '--version') $out = 'iptables v1.8.10 (nf_tables)';
        elseif ($args[3] === '-S') {
            $chain = $args[4];
            $out = $chain === 'FORWARD' ? $forward : ($chain === 'DOCKER-USER'
                ? implode("\n", array_merge(['-N DOCKER-USER'], array_values($installed[$tool] ?? []))) . $custom
                : '-P ' . $chain . ' ACCEPT');
        } else {
            $verb = $args[3];
            $rule = '-A DOCKER-USER ' . implode(' ', array_slice($args, $verb === '-I' ? 6 : 5));
            if ($verb === '-C') $code = isset($installed[$tool][$rule]) ? 0 : 1;
            elseif ($verb === '-I') {
                if ($failInsert && count($writes) === 1) return ['code' => 2, 'stdout' => '', 'stderr' => 'fixture failure'];
                $installed[$tool][$rule] = $rule; $writes[] = $args;
            } elseif ($verb === '-D') { unset($installed[$tool][$rule]); $writes[] = $args; }
            else throw new RuntimeException('Unexpected mutation');
        }
    } else throw new RuntimeException('Unexpected tool');
    return ['code' => $code, 'stdout' => $out, 'stderr' => ''];
}
function vpnRun(array $args, int $timeout, string $message): array {
    $r = vpnCommand($args, $timeout);
    if ($r['code']) throw new VpnOperationException('VPN_OPERATION_FAILED', $message);
    return $r;
}
$state = ['firewallMode' => 'docker', 'egressInterface' => 'eth0', 'ipv4Cidr' => '10.66.66.0/24', 'ipv6Cidr' => 'fd12:3456:789a:1::/64', 'ipv6Egress' => true];
check(vpnFirewallMode()['mode'] === 'docker', 'Recognize standard Docker default-drop');
$custom = "\n-A DOCKER-USER -j DROP";
check(vpnFirewallMode()['mode'] === 'unsupported', 'Preserve custom Docker policy');
$custom = '';
$ruleset['nftables'][] = ['chain' => ['family' => 'inet', 'table' => 'custom', 'name' => 'input', 'hook' => 'input', 'policy' => 'drop']];
check(vpnFirewallMode($state)['mode'] === 'unsupported', 'An owned VPN must not hide a foreign input drop');
array_pop($ruleset['nftables']);
$ruleset['nftables'][] = ['chain' => ['family' => 'inet', 'table' => 'custom', 'name' => 'forward', 'hook' => 'forward', 'policy' => 'accept']];
check(vpnFirewallMode()['mode'] === 'unsupported', 'Unknown forwarding chain must block');
array_pop($ruleset['nftables']);
$failRead = true;
check(vpnFirewallMode()['mode'] === 'unsupported', 'Inspection failure must block');
$failRead = false;
check(!vpnDockerLayout(str_replace('-j DOCKER-USER', '-j ACCEPT', $forward), '-N DOCKER-USER'), 'Reject a changed forwarding jump');
vpnDockerForwarding($state, 'start');
check(count($writes) === 4 && vpnDockerForwarding($state, 'check'), 'Install exact IPv4 and IPv6 rules');
vpnDockerForwarding($state, 'start');
check(count($writes) === 4, 'Repeated start is idempotent');
foreach ($writes as $args) {
    check($args[4] === 'DOCKER-USER' && in_array('pnlwg0', $args, true) && in_array('eth0', $args, true), 'Only VPN forwarding may be changed');
    check(in_array('-s', $args, true) || (in_array('-d', $args, true) && in_array('RELATED,ESTABLISHED', $args, true)), 'Scope source and return traffic');
}
$custom = "\n-A DOCKER-USER -j DROP";
try { vpnDockerForwarding($state, 'start'); throw new RuntimeException('Expected drift rejection'); }
catch (VpnOperationException $error) { check($error->brokerCode === 'VPN_CONFLICT', 'Reject changed policy before writes'); }
vpnDockerForwarding($state, 'stop');
check($custom !== '' && !array_filter($installed), 'Cleanup retains unrelated rules');
check(!vpnDockerForwarding($state, 'check'), 'Missing rules fail runtime health');
$custom = ''; $writes = []; $failInsert = true;
try { vpnDockerForwarding($state, 'start'); throw new RuntimeException('Expected insertion failure'); }
catch (VpnOperationException) { vpnDockerForwarding($state, 'stop'); }
check(!array_filter($installed), 'Partial installation can be rolled back');
check(vpnDockerRules(array_replace($state, ['ipv6Egress' => false]), true) === [], 'No IPv6 bypass without egress');
echo "VPN firewall fixtures passed (classification, drift, isolation, lifecycle, partial rollback).\n";
