const { spawn } = require("child_process");
const path = require("path");

function run(executable, args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn("sudo", ["-n", executable, ...args], {
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => stdout += chunk.toString("utf8"));
    child.stderr.on("data", (chunk) => stderr += chunk.toString("utf8"));
    child.stdin.end(input);
    child.on("close", (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

run("/usr/bin/php", [path.join(process.cwd(), "scripts", "cloudpanel-bridge.php")], JSON.stringify({
  action: "site-section",
  username: "admin",
  domain: "panel.152.239.123.12.mehebub.com",
  section: "git"
})).then(console.log);
