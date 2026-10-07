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
function hostListeningPortInspection(Site $site): array {
    return [
        'available' => $GLOBALS['inspectionAvailable'] ?? true,
        'listeners' => $GLOBALS['listeners'],
        'detail' => ($GLOBALS['inspectionAvailable'] ?? true)
            ? 'Listener ownership was inspected.'
            : 'Listener inspection is unavailable.',
    ];
}
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
    $inspectionAvailable = true;
    $listeners = [['port' => 20004, 'address' => $address, 'siteOwned' => $owned, 'process' => 'node']];
    $probes = 0;
    $capability = sitePortCapability($site, hostListeningPortInspection($site));
    if ($owned && $verification === 'failed') check(str_contains($capability['detail'], 'not bound to loopback'), 'Explain site-owned wildcard listener');
    if (!$owned) check(str_contains($capability['detail'], 'could not verify'), 'Do not assert foreign ownership without evidence');
    $result = executeOperationSteps($site, [$step])[0];
    check($result['applicationHealth'] === $health, 'Report HTTP health separately');
    check($result['portVerification'] === $verification, 'Retain loopback verification');
    check($result['exitCode'] === ($verification === 'passed' ? 0 : 1), 'Unsafe binding still fails verification');
    check($probes === ($owned ? 1 : 0), 'Never probe an unverified foreign listener');
}
$inspectionAvailable = false;
$listeners = [];
$probes = 0;
$capability = sitePortCapability($site, hostListeningPortInspection($site));
check($capability['inspectionAvailable'] === false, 'Expose listener inspection availability');
check(str_contains($capability['detail'], 'unavailable'), 'Explain unavailable listener inspection');
$result = executeOperationSteps($site, [$step])[0];
check($result['applicationHealth'] === 'not_checked', 'Do not claim application health when listener inspection is unavailable');
check($result['portVerification'] === 'failed', 'Fail deployment verification when listener ownership cannot be verified');
check($result['exitCode'] === 1, 'Unavailable listener inspection must not pass deployment verification');
check($probes === 0, 'Never probe a listener whose ownership could not be inspected');
echo "Deployment listener verification tests passed.\n";
