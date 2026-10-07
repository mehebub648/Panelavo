<?php
declare(strict_types=1);
$source = file_get_contents(__DIR__ . '/cloudpanel-bridge.php');
function loadFunction(string $start, string $end): void {
    global $source;
    $offset = strpos($source, 'function ' . $start . '(');
    eval(substr($source, $offset, strpos($source, 'function ' . $end . '(', $offset) - $offset));
}
class Site {}
function expectedSitePort(Site $site): int { return 20004; }
function deploymentEvent(array $event): void {}
function redactDeploymentText(string $text): string { return $text; }
function hostListeningPorts(Site $site): array { return $GLOBALS['listeners']; }
function runSiteCommand(...$args): array {
    $GLOBALS['probes']++;
    return ['code' => 0, 'timedOut' => false, 'stdout' => 'HTTP 200', 'stderr' => ''];
}
function check(bool $ok, string $message): void { if (!$ok) throw new RuntimeException($message); }
loadFunction('isSafeEndpointAddress', 'manageSiteEndpoint');
loadFunction('sitePortCapability', 'composeLabels');
loadFunction('deploymentHttpSucceeded', 'composeDeploymentReady');
loadFunction('executeOperationSteps', 'runFixStep');
$site = new Site();
$step = ['command' => 'runtime-port-verify', 'label' => 'Verify upstream', 'args' => ['curl'], 'timeout' => 120, 'verifyOwnedPort' => 20004];
foreach ([['127.0.0.1:20004', true, 'passed', 'healthy'], ['0.0.0.0:20004', true, 'failed', 'healthy'], ['127.0.0.1:20004', false, 'failed', 'not_checked']] as [$address, $owned, $verification, $health]) {
    $listeners = [['port' => 20004, 'address' => $address, 'siteOwned' => $owned, 'process' => 'node']];
    $probes = 0;
    $capability = sitePortCapability($site, $listeners);
    if ($owned && $verification === 'failed') check(str_contains($capability['detail'], 'not bound to loopback'), 'Explain site-owned wildcard listener');
    if (!$owned) check(str_contains($capability['detail'], 'could not verify'), 'Do not assert foreign ownership without evidence');
    $result = executeOperationSteps($site, [$step])[0];
    check($result['applicationHealth'] === $health, 'Report HTTP health separately');
    check($result['portVerification'] === $verification, 'Retain loopback verification');
    check($result['exitCode'] === ($verification === 'passed' ? 0 : 1), 'Unsafe binding still fails verification');
    check($probes === ($owned ? 1 : 0), 'Never probe an unverified foreign listener');
}
echo "Deployment listener verification tests passed.\n";
