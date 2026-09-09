<?php
declare(strict_types=1);
// Run real pure broker functions without booting CloudPanel or executing mutations.
$source = file_get_contents(__DIR__ . '/cloudpanel-bridge.php');
function loadFunctions(string $startName, string $endName): void {
    global $source;
    $start = strpos($source, 'function ' . $startName . '(');
    $end = strpos($source, 'function ' . $endName . '(', $start);
    eval(substr($source, $start, $end - $start));
}
function respond(array $value): never { throw new RuntimeException($value['code'] ?? 'INVALID_REQUEST'); }
function invalidBrokerRequest(): never { throw new RuntimeException('INVALID_REQUEST'); }
function check(bool $condition, string $message): void { if (!$condition) throw new RuntimeException($message); }
loadFunctions('deploymentHttpSucceeded', 'deploymentEvent');
loadFunctions('envDriftForRunning', 'actionsSection');
function dotenvOperationEnv(string $root): array { return []; }
loadFunctions('resolveOperationStep', 'resolveDeploymentPlan');
loadFunctions('resolveCustomDeployment', 'deploymentHealthStep');
foreach ([200, 204, 301, 399] as $status) check(deploymentHttpSucceeded('HTTP ' . $status), 'Accept successful/redirect responses');
foreach ([0, 100, 400, 401, 404, 500, 503] as $status) check(!deploymentHttpSucceeded('HTTP ' . $status), 'Reject error and missing responses');
check(redactDeploymentText('https://user:sec@ret@git.test/repo Bearer abc123') === 'https://[redacted]@git.test/repo Bearer [redacted]', 'Remote URL and bearer credentials are redacted');
$row = ['Service' => 'app', 'State' => 'running', 'Health' => 'healthy'];
check(composeDeploymentReady(json_encode([$row]), ['app'], [], 'app'), 'Healthy service');
check(!composeDeploymentReady(json_encode([$row + ['unused' => true]]), ['app', 'db'], [], 'app'), 'Missing service blocks');
foreach (['starting', 'unhealthy'] as $health) check(!composeDeploymentReady(json_encode([array_replace($row, ['Health' => $health])]), ['app'], [], 'app'), 'Wait for health');
check(!composeDeploymentReady(json_encode([array_replace($row, ['State' => 'exited'])]), ['app'], [], 'app'), 'Stopped app blocks');
check(composeDeploymentReady(json_encode($row), ['app'], [], 'app'), 'Compose JSON-lines output');
$dotenv = ['PORT' => '127.0.0.1:31000', 'APP_MODE' => 'production'];
$resolved = ['APP_MODE' => 'production'];
check(envDriftForRunning($resolved, [['APP_MODE' => 'production']]) === [['key' => 'APP_MODE', 'status' => 'match']], 'Interpolation-only PORT is not expected inside the container');
check(envDriftForRunning($resolved, [['APP_MODE' => 'development']])[0]['status'] === 'differs', 'Real environment change remains visible');
$state = ['path' => '/app', 'tools' => ['python' => ['available' => true]], 'packageManager' => null, 'pythonManager' => ['id' => 'pip', 'available' => true], 'venvPython' => null, 'hasPythonVenv' => false, 'scripts' => [], 'hasRequirements' => true];
$steps = resolveCustomDeployment($state, [['command' => 'python-create-venv'], ['command' => 'python-install']]);
check($steps[1]['args'][0] === '/app/.venv/bin/python', 'Later install uses environment created by the first step');
try { resolveCustomDeployment($state, [['command' => 'python-install']]); throw new LogicException('Missing environment accepted'); } catch (RuntimeException $error) { check($error->getMessage() === 'ACTION_UNAVAILABLE', 'Missing prerequisite blocks'); }
$pm2 = ['path' => '/app', 'scripts' => [], 'tools' => ['pm2' => ['available' => true], 'npm' => ['available' => true]], 'packageManager' => ['id' => 'npm'], 'pythonManager' => null, 'ecosystemFile' => null, 'hasStartScript' => true, 'processName' => 'app', 'pm2ProcessNames' => ['app']];
check(resolveOperationStep($pm2, 'pm2-start', [])['args'] === ['pm2', 'restart', 'app', '--update-env'], 'A second deployment restarts the existing application instead of creating a duplicate');
echo "Deployment health, Compose readiness, environment, and sequence tests passed.\n";
