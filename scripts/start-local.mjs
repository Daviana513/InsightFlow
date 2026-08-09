import { spawn } from "node:child_process";

const children = [
  spawn("python3", ["agent/server.py"], { stdio: "inherit" }),
  spawn("npm", ["run", "dev"], { stdio: "inherit" }),
];

function stop(code = 0) {
  for (const child of children) child.kill("SIGTERM");
  process.exit(code);
}

for (const child of children) {
  child.on("exit", (code, signal) => {
    if (code && !signal) stop(code);
  });
}

process.on("SIGINT", () => stop());
process.on("SIGTERM", () => stop());
